import { invariant } from "../domain/errors.js";
import type { TaskResult, TeamMember, TeamRecord, TeamTask } from "../domain/types.js";

const OPEN_TASK_STATUSES = new Set(["pending", "claimed", "in_progress"]);

export function validateTaskGraph(team: TeamRecord): void {
  const tasks = new Map(team.tasks.map((task) => [task.id, task]));
  for (const task of team.tasks) {
    for (const dependency of task.dependencies) {
      invariant(
        dependency !== task.id,
        `任务 ${task.id} 不能依赖自身`,
        "CYCLIC_DEPENDENCY",
      );
      invariant(
        tasks.has(dependency),
        `任务 ${task.id} 的依赖 ${dependency} 不存在`,
        "DEPENDENCY_NOT_FOUND",
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    invariant(
      !visiting.has(taskId),
      `任务依赖图存在环：${taskId}`,
      "CYCLIC_DEPENDENCY",
    );
    visiting.add(taskId);
    for (const dependency of tasks.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of team.tasks) visit(task.id);
}

export function readyTasks(team: TeamRecord): TeamTask[] {
  if (team.status !== "running") return [];
  const tasks = new Map(team.tasks.map((task) => [task.id, task]));
  return team.tasks
    .filter((task) => task.status === "pending")
    .filter((task) =>
      task.dependencies.every(
        (dependency) => tasks.get(dependency)?.status === "completed",
      ),
    )
    .sort((left, right) => left.sequence - right.sequence);
}

export function selectMember(
  team: TeamRecord,
  task: TeamTask,
): TeamMember | undefined {
  const available = team.members.filter(
    (member) => member.status === "idle" && !member.currentTaskId,
  );
  if (task.assignee) {
    return available.find((member) => member.id === task.assignee);
  }
  return available[0];
}

export function hasOpenTasks(team: TeamRecord): boolean {
  return team.tasks.some((task) => OPEN_TASK_STATUSES.has(task.status));
}

export function blockedTasks(team: TeamRecord): TeamTask[] {
  const failedIds = new Set(
    team.tasks
      .filter((task) => task.status === "failed" || task.status === "cancelled")
      .map((task) => task.id),
  );
  return team.tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.dependencies.some((dependency) => failedIds.has(dependency)),
  );
}

export function validateQualityResult(task: TeamTask, result: TaskResult): void {
  if (task.kind === "work") return;

  if (task.acceptance?.length) {
    invariant(
      result.acceptanceResults?.length === task.acceptance.length,
      `任务 ${task.id} 必须逐项报告验收结果`,
      "INCOMPLETE_ACCEPTANCE",
    );
    const reported = new Set(
      result.acceptanceResults?.map((entry) => entry.criterion) ?? [],
    );
    for (const criterion of task.acceptance) {
      invariant(
        reported.has(criterion),
        `缺少验收项：${criterion}`,
        "INCOMPLETE_ACCEPTANCE",
      );
    }
  }

  if (task.kind === "review" || task.kind === "requirements") {
    invariant(result.verdict, `任务 ${task.id} 必须提供 verdict`, "MISSING_VERDICT");
    if (result.verdict !== "pass") {
      invariant(
        Boolean(result.findings?.length),
        `未通过的 ${task.kind} 任务必须包含 findings`,
        "MISSING_FINDINGS",
      );
    }
  }

  if (task.kind === "implementation" || task.kind === "repair") {
    invariant(
      Array.isArray(result.changedPaths),
      `任务 ${task.id} 必须报告 changedPaths`,
      "MISSING_CHANGED_PATHS",
    );
    if (task.inScope?.length && result.changedPaths) {
      for (const changed of result.changedPaths) {
        invariant(
          task.inScope.some((scope) => isWithinScope(changed, scope)),
          `变更 ${changed} 不在任务范围内`,
          "OUT_OF_SCOPE_CHANGE",
          { changed, inScope: task.inScope },
        );
      }
    }
  }
}

export function resultPasses(task: TeamTask, result: TaskResult): boolean {
  if (result.verdict && result.verdict !== "pass") return false;
  return !(result.acceptanceResults?.some((entry) => !entry.passed) ?? false);
}

function isWithinScope(changedPath: string, scope: string): boolean {
  const normalizedChanged = changedPath.replaceAll("\\", "/");
  const normalizedScope = scope.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedScope === "." || normalizedScope === "") return true;
  return (
    normalizedChanged === normalizedScope ||
    normalizedChanged.startsWith(`${normalizedScope}/`)
  );
}
