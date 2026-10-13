export const TEAM_SCHEMA_VERSION = 1 as const;

export type TeamStatus =
  | "draft"
  | "running"
  | "halted"
  | "completed"
  | "archived";

export type MemberStatus = "idle" | "running" | "offline" | "failed" | "removed";

export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskKind =
  | "work"
  | "requirements"
  | "implementation"
  | "verification"
  | "review"
  | "repair"
  | "integration";

export type Verdict = "pass" | "needs_revision" | "reject";

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  model: string;
  reasoningEffort?: string;
  readonly: boolean;
  background: boolean;
  toolPolicy?: ToolPolicy;
  status: MemberStatus;
  agentId?: string;
  currentTaskId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceResult {
  criterion: string;
  passed: boolean;
  evidence?: string;
}

export interface TaskResult {
  summary: string;
  output?: string;
  verdict?: Verdict;
  findings?: string[];
  acceptanceResults?: AcceptanceResult[];
  commandsRun?: string[];
  changedPaths?: string[];
}

export interface TaskAttempt {
  number: number;
  id: string;
  memberId: string;
  agentId?: string;
  runId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface TeamTask {
  id: string;
  sequence: number;
  subject: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  dependencies: string[];
  assignee?: string;
  objective?: string;
  acceptance?: string[];
  inScope?: string[];
  outOfScope?: string[];
  verify?: string[];
  attempt: number;
  attemptId?: string;
  attempts: TaskAttempt[];
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  taskId?: string;
  createdAt: string;
  readAt?: string;
}

export interface TeamRecord {
  schemaVersion: typeof TEAM_SCHEMA_VERSION;
  id: string;
  name: string;
  goal: string;
  workspace: string;
  status: TeamStatus;
  approval: "required" | "automatic";
  approvedAt?: string;
  haltedReason?: string;
  dashboardPort?: number;
  members: TeamMember[];
  tasks: TeamTask[];
  nextSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  goal: string;
  status: TeamStatus;
  memberCount: number;
  taskCounts: Record<TaskStatus, number>;
  updatedAt: string;
}

export interface CreateTeamInput {
  name: string;
  goal: string;
  workspace: string;
  approval?: "required" | "automatic";
}

export interface AddMemberInput {
  name: string;
  role: string;
  model?: string;
  reasoningEffort?: string;
  readonly?: boolean;
  background?: boolean;
  toolPolicy?: ToolPolicy;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  kind?: TaskKind;
  dependencies?: string[];
  assignee?: string;
  objective?: string;
  acceptance?: string[];
  inScope?: string[];
  outOfScope?: string[];
  verify?: string[];
}

export interface RuntimeTask {
  teamId: string;
  teamGoal: string;
  workspace: string;
  member: TeamMember;
  task: TeamTask;
  dependencyResults: Array<{
    taskId: string;
    subject: string;
    result?: TaskResult;
  }>;
}

export interface RuntimeResult {
  agentId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled";
  result?: TaskResult;
  error?: string;
}

export interface AgentRuntime {
  execute(
    input: RuntimeTask,
    onStarted?: (ids: { agentId: string; runId: string }) => Promise<void>,
  ): Promise<RuntimeResult>;
  cancel(agentId: string, runId?: string): Promise<void>;
}

export interface TeamEvent {
  id: string;
  teamId: string;
  type:
    | "team.created"
    | "team.approved"
    | "team.halted"
    | "team.resumed"
    | "team.archived"
    | "member.added"
    | "member.updated"
    | "task.created"
    | "task.started"
    | "task.completed"
    | "task.failed"
    | "task.cancelled"
    | "message.sent";
  at: string;
  payload: Record<string, unknown>;
}
