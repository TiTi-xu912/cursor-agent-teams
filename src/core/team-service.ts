import path from "node:path";
import { AgentTeamsError, errorMessage, invariant } from "../domain/errors.js";
import { createId, now, slug } from "../domain/ids.js";
import type {
  AddMemberInput,
  AgentRuntime,
  CreateTaskInput,
  CreateTeamInput,
  TaskResult,
  TeamEvent,
  TeamMember,
  TeamMessage,
  TeamRecord,
  TeamTask,
} from "../domain/types.js";
import { TEAM_SCHEMA_VERSION } from "../domain/types.js";
import {
  blockedTasks,
  hasOpenTasks,
  readyTasks,
  resultPasses,
  selectMember,
  validateQualityResult,
  validateTaskGraph,
} from "./scheduler.js";
import { FileStateStore } from "./state-store.js";

export interface TeamServiceOptions {
  defaultModel?: string;
  maxMembers?: number;
  maxRepairRounds?: number;
}

export class TeamService {
  private readonly activeSchedulers = new Map<string, Promise<void>>();
  private readonly defaultModel: string;
  private readonly maxMembers: number;
  private readonly maxRepairRounds: number;

  constructor(
    readonly store: FileStateStore,
    private readonly runtime?: AgentRuntime,
    options: TeamServiceOptions = {},
  ) {
    this.defaultModel = options.defaultModel ?? process.env.CURSOR_MODEL ?? "auto";
    this.maxMembers = options.maxMembers ?? 8;
    this.maxRepairRounds = options.maxRepairRounds ?? 2;
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    const timestamp = now();
    const workspace = path.resolve(input.workspace);
    invariant(
      workspace === path.resolve(this.store.workspace),
      "团队 workspace 必须与 MCP 服务绑定的 workspace 一致",
      "WORKSPACE_MISMATCH",
    );
    const team: TeamRecord = {
      schemaVersion: TEAM_SCHEMA_VERSION,
      id: `team_${slug(input.name)}_${createId("x").slice(-6)}`,
      name: input.name.trim(),
      goal: input.goal.trim(),
      workspace,
      status: "draft",
      approval: input.approval ?? "required",
      members: [],
      tasks: [],
      nextSequence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    invariant(team.name, "团队名称不能为空", "INVALID_TEAM");
    invariant(team.goal, "团队目标不能为空", "INVALID_TEAM");
    await this.store.create(team);
    await this.event(team.id, "team.created", { name: team.name, goal: team.goal });
    return team;
  }

  async addMember(teamId: string, input: AddMemberInput): Promise<TeamRecord> {
    const team = await this.store.update(teamId, (draft) => {
      invariant(draft.status === "draft", "只能在草案阶段添加成员");
      invariant(draft.members.length < this.maxMembers, "已达到团队成员上限");
      const name = input.name.trim();
      invariant(name, "成员名称不能为空", "INVALID_MEMBER");
      invariant(
        !draft.members.some((member) => member.name === name),
        `成员名称 ${name} 已存在`,
        "MEMBER_EXISTS",
      );
      const timestamp = now();
      const member: TeamMember = {
        id: createId("member"),
        name,
        role: input.role.trim(),
        model: input.model ?? this.defaultModel,
        readonly: input.readonly ?? false,
        background: input.background ?? false,
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
      };
      invariant(member.role, "成员角色不能为空", "INVALID_MEMBER");
      validateToolPolicy(member);
      draft.members.push(member);
    });
    const member = team.members.at(-1);
    await this.event(teamId, "member.added", {
      memberId: member?.id,
      name: member?.name,
    });
    return team;
  }

  async createTask(teamId: string, input: CreateTaskInput): Promise<TeamRecord> {
    const team = await this.store.update(teamId, (draft) => {
      invariant(
        draft.status === "draft" || draft.status === "running",
        "只能向草案或运行中的团队添加任务",
      );
      if (input.assignee) {
        invariant(
          draft.members.some(
            (member) => member.id === input.assignee && member.status !== "removed",
          ),
          `负责人 ${input.assignee} 不存在`,
          "MEMBER_NOT_FOUND",
        );
      }
      for (const dependency of input.dependencies ?? []) {
        invariant(
          draft.tasks.some((task) => task.id === dependency),
          `依赖任务 ${dependency} 不存在`,
          "DEPENDENCY_NOT_FOUND",
        );
      }
      const timestamp = now();
      const task: TeamTask = {
        id: createId("task"),
        sequence: draft.nextSequence++,
        subject: input.subject.trim(),
        description: input.description.trim(),
        kind: input.kind ?? "work",
        status: "pending",
        dependencies: [...new Set(input.dependencies ?? [])],
        attempt: 0,
        attempts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.assignee ? { assignee: input.assignee } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
        ...(input.inScope ? { inScope: input.inScope } : {}),
        ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
        ...(input.verify ? { verify: input.verify } : {}),
      };
      invariant(task.subject, "任务标题不能为空", "INVALID_TASK");
      invariant(task.description, "任务描述不能为空", "INVALID_TASK");
      validateTaskContract(task);
      draft.tasks.push(task);
      validateTaskGraph(draft);
    });
    const task = team.tasks.at(-1);
    await this.event(teamId, "task.created", {
      taskId: task?.id,
      subject: task?.subject,
    });
    if (team.status === "running") void this.start(teamId);
    return team;
  }

  async approve(teamId: string): Promise<TeamRecord> {
    const team = await this.store.update(teamId, (draft) => {
      invariant(draft.status === "draft", "只有草案团队可以批准");
      invariant(draft.members.length > 0, "团队至少需要一名成员");
      invariant(draft.tasks.length > 0, "团队至少需要一个任务");
      validateTaskGraph(draft);
      draft.status = "running";
      draft.approvedAt = now();
      for (const member of draft.members) {
        if (member.status !== "removed") member.status = "idle";
      }
    });
    await this.event(teamId, "team.approved", {});
    if (this.runtime) void this.start(teamId);
    return team;
  }

  async status(teamId: string): Promise<TeamRecord> {
    return this.store.get(teamId, true);
  }

  async start(teamId: string): Promise<void> {
    if (!this.runtime) {
      throw new AgentTeamsError(
        "未配置 Cursor SDK runtime，无法执行任务",
        "RUNTIME_UNAVAILABLE",
      );
    }
    const existing = this.activeSchedulers.get(teamId);
    if (existing) return existing;
    const scheduler = this.runScheduler(teamId).finally(() => {
      if (this.activeSchedulers.get(teamId) === scheduler) {
        this.activeSchedulers.delete(teamId);
      }
    });
    this.activeSchedulers.set(teamId, scheduler);
    return scheduler;
  }

  async recover(teamId: string): Promise<TeamRecord> {
    const team = await this.store.update(teamId, (draft) => {
      invariant(draft.status === "running", "只能恢复运行中的团队");
      for (const member of draft.members) {
        if (member.status === "running") {
          member.status = "idle";
          delete member.currentTaskId;
          member.updatedAt = now();
        }
      }
      for (const task of draft.tasks) {
        if (task.status !== "claimed" && task.status !== "in_progress") continue;
        const attempt = task.attempts.find(
          (candidate) => candidate.id === task.attemptId,
        );
        if (attempt?.status === "running") {
          attempt.status = "failed";
          attempt.finishedAt = now();
          attempt.error = "服务重启后执行状态未知，已安全重试";
        }
        task.status = "pending";
        delete task.attemptId;
        task.updatedAt = now();
      }
    });
    if (this.runtime) void this.start(teamId);
    return team;
  }

  async halt(teamId: string, reason: string): Promise<TeamRecord> {
    const snapshot = await this.store.get(teamId);
    const activeAttempts = snapshot.tasks
      .flatMap((task) => task.attempts)
      .filter((attempt) => attempt.status === "running");
    await Promise.allSettled(
      activeAttempts.map((attempt) =>
        this.runtime?.cancel(attempt.agentId ?? "", attempt.runId),
      ),
    );
    const team = await this.store.update(teamId, (draft) => {
      invariant(draft.status === "running", "只有运行中的团队可以停止");
      draft.status = "halted";
      draft.haltedReason = reason.trim() || "用户停止";
      for (const member of draft.members) {
        if (member.status === "running") {
          member.status = "idle";
          delete member.currentTaskId;
        }
      }
      for (const task of draft.tasks) {
        if (task.status === "claimed" || task.status === "in_progress") {
          task.status = "cancelled";
          task.updatedAt = now();
          const attempt = task.attempts.find(
            (candidate) => candidate.id === task.attemptId,
          );
          if (attempt?.status === "running") {
            attempt.status = "cancelled";
            attempt.finishedAt = now();
          }
        }
      }
    });
    await this.event(teamId, "team.halted", { reason: team.haltedReason });
    return team;
  }

  async resume(teamId: string, reason: string): Promise<TeamRecord> {
    invariant(reason.trim(), "恢复团队必须提供原因", "MISSING_REASON");
    const team = await this.store.update(teamId, (draft) => {
      invariant(draft.status === "halted", "只有已停止团队可以恢复");
      draft.status = "running";
      delete draft.haltedReason;
      for (const task of draft.tasks) {
        if (task.status === "cancelled") {
          task.status = "pending";
          delete task.attemptId;
          task.updatedAt = now();
        }
      }
    });
    await this.event(teamId, "team.resumed", { reason });
    if (this.runtime) void this.start(teamId);
    return team;
  }

  async reassignTask(
    teamId: string,
    taskId: string,
    memberId: string,
  ): Promise<TeamRecord> {
    const current = await this.store.get(teamId);
    const task = findTask(current, taskId);
    const runningAttempt = task.attempts.find(
      (attempt) => attempt.id === task.attemptId && attempt.status === "running",
    );
    if (runningAttempt && this.runtime) {
      await this.runtime.cancel(runningAttempt.agentId ?? "", runningAttempt.runId);
    }
    const team = await this.store.update(teamId, (draft) => {
      invariant(
        draft.members.some(
          (member) => member.id === memberId && member.status !== "removed",
        ),
        `成员 ${memberId} 不存在`,
        "MEMBER_NOT_FOUND",
      );
      const target = findTask(draft, taskId);
      invariant(
        target.status !== "completed",
        "已完成任务不能重新分配",
        "TASK_TERMINAL",
      );
      if (target.assignee) {
        const previousMember = draft.members.find(
          (member) => member.id === target.assignee,
        );
        if (previousMember?.currentTaskId === target.id) {
          previousMember.status = "idle";
          delete previousMember.currentTaskId;
        }
      }
      const attempt = target.attempts.find(
        (candidate) => candidate.id === target.attemptId,
      );
      if (attempt?.status === "running") {
        attempt.status = "cancelled";
        attempt.finishedAt = now();
      }
      target.assignee = memberId;
      target.status = "pending";
      delete target.attemptId;
      target.updatedAt = now();
    });
    if (team.status === "running" && this.runtime) void this.start(teamId);
    return team;
  }

  async sendMessage(
    teamId: string,
    from: string,
    to: string,
    body: string,
    taskId?: string,
  ): Promise<TeamMessage> {
    const team = await this.store.get(teamId);
    const identities = new Set(["captain", ...team.members.map((member) => member.id)]);
    invariant(identities.has(from), `发件人 ${from} 不存在`, "MEMBER_NOT_FOUND");
    invariant(identities.has(to), `收件人 ${to} 不存在`, "MEMBER_NOT_FOUND");
    if (taskId) findTask(team, taskId);
    const message: TeamMessage = {
      id: createId("message"),
      from,
      to,
      body: body.trim(),
      createdAt: now(),
      ...(taskId ? { taskId } : {}),
    };
    invariant(message.body, "消息不能为空", "INVALID_MESSAGE");
    await this.store.appendMessage(teamId, message);
    await this.event(teamId, "message.sent", {
      messageId: message.id,
      from,
      to,
      taskId,
    });
    return message;
  }

  async archive(teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(teamId);
    invariant(
      team.status !== "running",
      "运行中的团队必须先停止或完成",
      "TEAM_RUNNING",
    );
    await this.event(teamId, "team.archived", {});
    return this.store.archive(teamId);
  }

  private async runScheduler(teamId: string): Promise<void> {
    while (true) {
      const snapshot = await this.store.get(teamId);
      if (snapshot.status !== "running") return;

      const reserved = structuredClone(snapshot);
      const allocations: Array<{ taskId: string; memberId: string }> = [];
      for (const task of readyTasks(reserved)) {
        const member = selectMember(reserved, task);
        if (!member) continue;
        allocations.push({ taskId: task.id, memberId: member.id });
        member.status = "running";
        member.currentTaskId = task.id;
      }

      if (allocations.length === 0) {
        if (!hasOpenTasks(snapshot)) {
          await this.store.update(teamId, (draft) => {
            if (draft.status === "running") draft.status = "completed";
          });
        } else if (
          !snapshot.tasks.some(
            (task) => task.status === "claimed" || task.status === "in_progress",
          ) &&
          blockedTasks(snapshot).length > 0
        ) {
          await this.store.update(teamId, (draft) => {
            draft.status = "halted";
            draft.haltedReason = "存在被失败或取消依赖阻塞的任务";
          });
        }
        return;
      }

      const claims = await Promise.all(
        allocations.map(({ taskId, memberId }) =>
          this.claimTask(teamId, taskId, memberId),
        ),
      );
      await Promise.all(claims.map((claim) => this.executeClaim(claim)));
    }
  }

  private async claimTask(
    teamId: string,
    taskId: string,
    memberId: string,
  ): Promise<{ team: TeamRecord; task: TeamTask; member: TeamMember }> {
    const attemptId = createId("attempt");
    const team = await this.store.update(teamId, (draft) => {
      const task = findTask(draft, taskId);
      const member = findMember(draft, memberId);
      invariant(task.status === "pending", `任务 ${taskId} 已被领取`);
      invariant(member.status === "idle", `成员 ${memberId} 当前不可用`);
      invariant(
        task.dependencies.every(
          (dependency) => findTask(draft, dependency).status === "completed",
        ),
        `任务 ${taskId} 的依赖尚未完成`,
      );
      task.status = "in_progress";
      task.assignee = member.id;
      task.attempt += 1;
      task.attemptId = attemptId;
      task.updatedAt = now();
      task.attempts.push({
        number: task.attempt,
        id: attemptId,
        memberId: member.id,
        status: "running",
        startedAt: now(),
      });
      member.status = "running";
      member.currentTaskId = task.id;
      member.updatedAt = now();
    });
    const task = findTask(team, taskId);
    const member = findMember(team, memberId);
    await this.event(teamId, "task.started", {
      taskId,
      memberId,
      attemptId,
    });
    return { team, task, member };
  }

  private async executeClaim(claim: {
    team: TeamRecord;
    task: TeamTask;
    member: TeamMember;
  }): Promise<void> {
    if (!this.runtime) return;
    const { team, task, member } = claim;
    const dependencyResults = task.dependencies.map((dependency) => {
      const dependencyTask = findTask(team, dependency);
      return {
        taskId: dependencyTask.id,
        subject: dependencyTask.subject,
        ...(dependencyTask.result ? { result: dependencyTask.result } : {}),
      };
    });
    try {
      const result = await this.runtime.execute(
        {
          teamId: team.id,
          teamGoal: team.goal,
          workspace: team.workspace,
          member,
          task,
          dependencyResults,
        },
        async ({ agentId, runId }) => {
          await this.store.update(team.id, (draft) => {
            const currentTask = findTask(draft, task.id);
            if (currentTask.attemptId !== task.attemptId) return;
            const attempt = currentTask.attempts.find(
              (candidate) => candidate.id === task.attemptId,
            );
            if (attempt) {
              attempt.agentId = agentId;
              attempt.runId = runId;
            }
            const currentMember = findMember(draft, member.id);
            currentMember.agentId = agentId;
          });
        },
      );
      if (result.status === "completed" && result.result) {
        await this.finishTask(team.id, task.id, task.attemptId!, result.result);
      } else {
        await this.failTask(
          team.id,
          task.id,
          task.attemptId!,
          result.error ?? `Cursor run ${result.status}`,
        );
      }
    } catch (error) {
      await this.failTask(
        team.id,
        task.id,
        task.attemptId!,
        errorMessage(error),
      );
    }
  }

  private async finishTask(
    teamId: string,
    taskId: string,
    attemptId: string,
    result: TaskResult,
  ): Promise<void> {
    let passed = true;
    const team = await this.store.update(teamId, (draft) => {
      const task = findTask(draft, taskId);
      invariant(
        task.attemptId === attemptId,
        "迟到的任务结果已被拒绝",
        "STALE_ATTEMPT",
      );
      validateQualityResult(task, result);
      passed = resultPasses(task, result);
      task.result = result;
      task.status = passed ? "completed" : "failed";
      task.updatedAt = now();
      const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
      if (attempt) {
        attempt.status = passed ? "completed" : "failed";
        attempt.finishedAt = now();
      }
      const member = findMember(draft, attempt?.memberId ?? task.assignee!);
      member.status = "idle";
      delete member.currentTaskId;
      member.updatedAt = now();
      if (!passed && task.kind === "review") this.addRepairLoop(draft, task);
    });
    await this.event(teamId, passed ? "task.completed" : "task.failed", {
      taskId,
      attemptId,
      verdict: result.verdict,
    });
    if (team.status === "running") void this.start(teamId);
  }

  private async failTask(
    teamId: string,
    taskId: string,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    const team = await this.store.update(teamId, (draft) => {
      const task = findTask(draft, taskId);
      if (task.attemptId !== attemptId) return;
      task.status = "failed";
      task.updatedAt = now();
      task.result = { summary: reason };
      const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
      if (attempt) {
        attempt.status = "failed";
        attempt.error = reason;
        attempt.finishedAt = now();
      }
      const member = draft.members.find(
        (candidate) => candidate.id === attempt?.memberId,
      );
      if (member) {
        member.status = "idle";
        member.lastError = reason;
        delete member.currentTaskId;
        member.updatedAt = now();
      }
    });
    await this.event(teamId, "task.failed", { taskId, attemptId, reason });
    if (team.status === "running") void this.start(teamId);
  }

  private addRepairLoop(team: TeamRecord, failedReview: TeamTask): void {
    const rounds = team.tasks.filter((task) => task.kind === "repair").length;
    if (rounds >= this.maxRepairRounds) {
      team.status = "halted";
      team.haltedReason = `审查修复已达到 ${this.maxRepairRounds} 轮上限`;
      return;
    }
    const implementation = [...team.tasks]
      .reverse()
      .find(
        (task) =>
          (task.kind === "implementation" || task.kind === "repair") &&
          failedReview.dependencies.includes(task.id),
      );
    if (!implementation?.assignee) return;
    const timestamp = now();
    const repair: TeamTask = {
      id: createId("task"),
      sequence: team.nextSequence++,
      subject: `Repair after ${failedReview.subject}`,
      description: `修复审查发现：${failedReview.result?.findings?.join("; ") ?? "未提供"}`,
      kind: "repair",
      status: "pending",
      dependencies: [...failedReview.dependencies],
      assignee: implementation.assignee,
      objective: `review:${failedReview.id} 修复审查问题`,
      acceptance: failedReview.acceptance ?? ["修复全部审查发现"],
      inScope: implementation.inScope ?? ["."],
      verify: implementation.verify ?? ["运行相关测试"],
      attempt: 0,
      attempts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const rereview: TeamTask = {
      id: createId("task"),
      sequence: team.nextSequence++,
      subject: `Re-review ${failedReview.subject}`,
      description: "独立复审修复结果并给出 pass/needs_revision/reject。",
      kind: "review",
      status: "pending",
      dependencies: [repair.id],
      objective: failedReview.objective ?? "复审实现质量",
      acceptance: failedReview.acceptance ?? ["全部审查发现已解决"],
      attempt: 0,
      attempts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(failedReview.assignee ? { assignee: failedReview.assignee } : {}),
    };
    for (const downstream of team.tasks) {
      if (
        downstream.status === "pending" &&
        downstream.dependencies.includes(failedReview.id)
      ) {
        downstream.dependencies = downstream.dependencies.map((dependency) =>
          dependency === failedReview.id ? rereview.id : dependency,
        );
        downstream.updatedAt = timestamp;
      }
    }
    team.tasks.push(repair, rereview);
  }

  private async event(
    teamId: string,
    type: TeamEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendEvent({
      id: createId("event"),
      teamId,
      type,
      at: now(),
      payload,
    });
  }
}

function findTask(team: TeamRecord, taskId: string): TeamTask {
  const task = team.tasks.find((candidate) => candidate.id === taskId);
  invariant(task, `任务 ${taskId} 不存在`, "TASK_NOT_FOUND");
  return task;
}

function findMember(team: TeamRecord, memberId: string): TeamMember {
  const member = team.members.find((candidate) => candidate.id === memberId);
  invariant(member, `成员 ${memberId} 不存在`, "MEMBER_NOT_FOUND");
  return member;
}

function validateTaskContract(task: TeamTask): void {
  if (task.kind === "work") return;
  invariant(task.objective?.trim(), `${task.kind} 任务必须提供 objective`);
  invariant(task.acceptance?.length, `${task.kind} 任务必须提供 acceptance`);
  if (task.kind === "implementation" || task.kind === "repair") {
    invariant(task.inScope?.length, `${task.kind} 任务必须提供 inScope`);
    invariant(task.verify?.length, `${task.kind} 任务必须提供 verify`);
  }
}

function validateToolPolicy(member: TeamMember): void {
  const policy = member.toolPolicy;
  if (!policy) return;
  invariant(
    !(policy.allow && policy.deny),
    "工具策略不能同时设置 allow 和 deny",
    "INVALID_TOOL_POLICY",
  );
  invariant(
    Boolean(policy.allow?.length || policy.deny?.length),
    "工具策略不能为空",
    "INVALID_TOOL_POLICY",
  );
}
