import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../src/core/state-store.js";
import { TeamService } from "../src/core/team-service.js";
import type {
  AgentRuntime,
  RuntimeResult,
  RuntimeTask,
  TaskResult,
} from "../src/domain/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TeamService", () => {
  it("executes dependency tasks in order and persists completion", async () => {
    const { service, runtime } = await fixture();
    const team = await service.createTeam({
      name: "delivery",
      goal: "Implement and verify a feature",
      workspace: service.store.workspace,
    });
    const withMember = await service.addMember(team.id, {
      name: "builder",
      role: "Implement changes",
      model: "auto",
    });
    const memberId = withMember.members[0]!.id;
    const first = await service.createTask(team.id, {
      subject: "Implement",
      description: "Implement the feature",
      assignee: memberId,
    });
    const firstId = first.tasks[0]!.id;
    await service.createTask(team.id, {
      subject: "Verify",
      description: "Verify the feature",
      assignee: memberId,
      dependencies: [firstId],
    });

    await service.approve(team.id);
    const completed = await waitForTeam(service, team.id, "completed");

    expect(runtime.subjects).toEqual(["Implement", "Verify"]);
    expect(completed.tasks.map((task) => task.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(completed.tasks[1]!.attempts[0]!.agentId).toBe("agent-builder");
  });

  it("creates a repair and re-review loop after review needs revision", async () => {
    const { service } = await fixture(
      new FakeRuntime((input) => {
        const acceptanceResults = (input.task.acceptance ?? []).map(
          (criterion) => ({ criterion, passed: true, evidence: "checked" }),
        );
        if (
          input.task.kind === "review" &&
          !input.task.subject.startsWith("Re-review")
        ) {
          return {
            summary: "Changes required",
            verdict: "needs_revision",
            findings: ["Missing edge-case handling"],
            acceptanceResults,
          };
        }
        return {
          summary: "Passed",
          acceptanceResults,
          commandsRun: ["npm test"],
          ...(input.task.kind === "review" ? { verdict: "pass" as const } : {}),
          ...(input.task.kind === "implementation" || input.task.kind === "repair"
            ? { changedPaths: ["src/feature.ts"] }
            : {}),
        };
      }),
    );
    const team = await service.createTeam({
      name: "quality",
      goal: "Quality-gated delivery",
      workspace: service.store.workspace,
    });
    const implementerTeam = await service.addMember(team.id, {
      name: "implementer",
      role: "Implement",
    });
    const reviewerTeam = await service.addMember(team.id, {
      name: "reviewer",
      role: "Review",
      readonly: true,
    });
    const implementer = implementerTeam.members[0]!.id;
    const reviewer = reviewerTeam.members[1]!.id;
    const implementationTeam = await service.createTask(team.id, {
      subject: "Implementation",
      description: "Implement feature",
      kind: "implementation",
      assignee: implementer,
      objective: "Deliver feature",
      acceptance: ["Feature works"],
      inScope: ["src"],
      verify: ["npm test"],
    });
    const implementation = implementationTeam.tasks[0]!.id;
    const reviewTeam = await service.createTask(team.id, {
      subject: "Independent review",
      description: "Review feature",
      kind: "review",
      assignee: reviewer,
      dependencies: [implementation],
      objective: "Review implementation",
      acceptance: ["Feature works"],
    });
    const review = reviewTeam.tasks[1]!.id;
    await service.createTask(team.id, {
      subject: "Integrate",
      description: "Prepare final integrated result",
      kind: "integration",
      assignee: implementer,
      dependencies: [review],
      objective: "Integrate reviewed change",
      acceptance: ["Feature works"],
    });

    await service.approve(team.id);
    const completed = await waitForTeam(service, team.id, "completed");

    expect(completed.tasks.map((task) => task.kind)).toEqual([
      "implementation",
      "review",
      "integration",
      "repair",
      "review",
    ]);
    expect(completed.tasks[1]!.status).toBe("failed");
    expect(completed.tasks[2]!.status).toBe("completed");
    expect(completed.tasks[3]!.status).toBe("completed");
    expect(completed.tasks[4]!.status).toBe("completed");
    expect(completed.tasks[2]!.dependencies).toEqual([completed.tasks[4]!.id]);
  });

  it("persists messages and archives a terminal team", async () => {
    const { service } = await fixture();
    const team = await service.createTeam({
      name: "mail",
      goal: "Test mailboxes",
      workspace: service.store.workspace,
    });
    const updated = await service.addMember(team.id, {
      name: "researcher",
      role: "Research",
      readonly: true,
    });
    const memberId = updated.members[0]!.id;
    await service.sendMessage(
      team.id,
      "captain",
      memberId,
      "Check the API contract",
    );
    const messages = await service.store.readMessages(team.id, memberId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("Check the API contract");

    const archived = await service.archive(team.id);
    expect(archived.status).toBe("archived");
    expect((await service.store.list(true))[0]!.status).toBe("archived");
  });

  it("halts after the configured repair-round limit", async () => {
    const runtime = new FakeRuntime((input) => {
      const acceptanceResults = (input.task.acceptance ?? []).map(
        (criterion) => ({
          criterion,
          passed: input.task.kind !== "review",
          evidence: "checked",
        }),
      );
      if (input.task.kind === "review") {
        return {
          summary: "Still failing",
          verdict: "reject",
          findings: ["Regression remains"],
          acceptanceResults,
        };
      }
      return {
        summary: "Done",
        acceptanceResults,
        ...(input.task.kind === "implementation" || input.task.kind === "repair"
          ? { changedPaths: ["src/fix.ts"] }
          : {}),
      };
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-agent-teams-"));
    temporaryDirectories.push(directory);
    const store = new FileStateStore(directory);
    await store.initialize();
    const service = new TeamService(store, runtime, { maxRepairRounds: 2 });
    const team = await service.createTeam({
      name: "bounded repair",
      goal: "Stop infinite reviews",
      workspace: directory,
    });
    const members = await service.addMember(team.id, {
      name: "worker",
      role: "Implement and repair",
    });
    const reviewerTeam = await service.addMember(team.id, {
      name: "reviewer",
      role: "Review",
      readonly: true,
    });
    const worker = members.members[0]!.id;
    const reviewer = reviewerTeam.members[1]!.id;
    const implementationTeam = await service.createTask(team.id, {
      subject: "Initial implementation",
      description: "Implement",
      kind: "implementation",
      assignee: worker,
      objective: "Implement safely",
      acceptance: ["No regressions"],
      inScope: ["src"],
      verify: ["npm test"],
    });
    await service.createTask(team.id, {
      subject: "Review",
      description: "Review",
      kind: "review",
      assignee: reviewer,
      dependencies: [implementationTeam.tasks[0]!.id],
      objective: "Review quality",
      acceptance: ["No regressions"],
    });

    await service.approve(team.id);
    const halted = await waitForTeam(service, team.id, "halted");
    expect(halted.tasks.filter((task) => task.kind === "repair")).toHaveLength(2);
    expect(halted.haltedReason).toContain("2 轮上限");
  });
});

class FakeRuntime implements AgentRuntime {
  readonly subjects: string[] = [];

  constructor(
    private readonly resultFactory: (input: RuntimeTask) => TaskResult = () => ({
      summary: "Done",
    }),
  ) {}

  async execute(
    input: RuntimeTask,
    onStarted?: (ids: { agentId: string; runId: string }) => Promise<void>,
  ): Promise<RuntimeResult> {
    this.subjects.push(input.task.subject);
    const agentId = `agent-${input.member.name}`;
    const runId = `run-${input.task.id}`;
    await onStarted?.({ agentId, runId });
    return {
      agentId,
      runId,
      status: "completed",
      result: compact(this.resultFactory(input)),
    };
  }

  async cancel(): Promise<void> {}
}

async function fixture(runtime = new FakeRuntime()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-agent-teams-"));
  temporaryDirectories.push(directory);
  const store = new FileStateStore(directory);
  await store.initialize();
  return {
    service: new TeamService(store, runtime),
    runtime,
  };
}

async function waitForTeam(
  service: TeamService,
  teamId: string,
  expected: "completed" | "halted",
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const team = await service.status(teamId);
    if (team.status === expected) return team;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const final = await service.status(teamId);
  throw new Error(
    `Team ${teamId} did not reach ${expected}: ${JSON.stringify({
      status: final.status,
      reason: final.haltedReason,
      tasks: final.tasks.map((task) => ({
        kind: task.kind,
        status: task.status,
        subject: task.subject,
      })),
    })}`,
  );
}

function compact(result: TaskResult): TaskResult {
  return JSON.parse(JSON.stringify(result)) as TaskResult;
}
