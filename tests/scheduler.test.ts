import { describe, expect, it } from "vitest";
import {
  blockedTasks,
  readyTasks,
  validateQualityResult,
  validateTaskGraph,
} from "../src/core/scheduler.js";
import type { TeamRecord, TeamTask } from "../src/domain/types.js";

describe("scheduler", () => {
  it("finds ready and blocked tasks from dependency state", () => {
    const first = task("first", "completed");
    const ready = task("ready", "pending", ["first"]);
    const failed = task("failed", "failed");
    const blocked = task("blocked", "pending", ["failed"]);
    const team = record([first, ready, failed, blocked]);

    expect(readyTasks(team).map((entry) => entry.id)).toEqual(["ready"]);
    expect(blockedTasks(team).map((entry) => entry.id)).toEqual(["blocked"]);
  });

  it("rejects cyclic task graphs", () => {
    const team = record([
      task("left", "pending", ["right"]),
      task("right", "pending", ["left"]),
    ]);
    expect(() => validateTaskGraph(team)).toThrow(/存在环/);
  });

  it("enforces review verdict and findings", () => {
    const review = {
      ...task("review", "in_progress"),
      kind: "review" as const,
      acceptance: ["No regressions"],
    };
    expect(() =>
      validateQualityResult(review, {
        summary: "Not ready",
        verdict: "needs_revision",
        acceptanceResults: [
          {
            criterion: "No regressions",
            passed: false,
            evidence: "A regression remains",
          },
        ],
      }),
    ).toThrow(/findings/);
  });
});

function task(
  id: string,
  status: TeamTask["status"],
  dependencies: string[] = [],
): TeamTask {
  return {
    id,
    sequence: 1,
    subject: id,
    description: id,
    kind: "work",
    status,
    dependencies,
    attempt: 0,
    attempts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function record(tasks: TeamTask[]): TeamRecord {
  return {
    schemaVersion: 1,
    id: "team_test",
    name: "test",
    goal: "test",
    workspace: ".",
    status: "running",
    approval: "required",
    members: [],
    tasks,
    nextSequence: tasks.length + 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
