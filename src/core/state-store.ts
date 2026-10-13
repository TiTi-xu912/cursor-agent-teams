import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AgentTeamsError, invariant } from "../domain/errors.js";
import type { TeamEvent, TeamMessage, TeamRecord, TeamSummary, TaskStatus } from "../domain/types.js";
import { TEAM_SCHEMA_VERSION } from "../domain/types.js";

const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "claimed",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
];

export class FileStateStore {
  readonly stateRoot: string;
  readonly teamsRoot: string;
  readonly archiveRoot: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly workspace: string, stateDir = ".cursor-agent-teams") {
    this.stateRoot = path.resolve(workspace, stateDir);
    this.teamsRoot = path.join(this.stateRoot, "teams");
    this.archiveRoot = path.join(this.stateRoot, "archive");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.teamsRoot, { recursive: true }),
      mkdir(this.archiveRoot, { recursive: true }),
    ]);
  }

  async create(team: TeamRecord): Promise<TeamRecord> {
    await this.initialize();
    const directory = this.teamDirectory(team.id);
    try {
      await access(directory);
      throw new AgentTeamsError(`团队 ${team.id} 已存在`, "TEAM_EXISTS");
    } catch (error) {
      if (error instanceof AgentTeamsError) throw error;
      if (!isMissingFile(error)) throw error;
    }
    await mkdir(path.join(directory, "inbox"), { recursive: true });
    await this.writeJsonAtomic(path.join(directory, "team.json"), team);
    return structuredClone(team);
  }

  async get(teamId: string, includeArchived = false): Promise<TeamRecord> {
    const activePath = path.join(this.teamDirectory(teamId), "team.json");
    try {
      return await this.readTeamFile(activePath);
    } catch (error) {
      if (!includeArchived || !isMissingFile(error)) throw error;
    }
    return this.readTeamFile(path.join(this.archiveDirectory(teamId), "team.json"));
  }

  async list(includeArchived = false): Promise<TeamSummary[]> {
    await this.initialize();
    const roots = includeArchived
      ? [this.teamsRoot, this.archiveRoot]
      : [this.teamsRoot];
    const teams: TeamRecord[] = [];
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          teams.push(await this.readTeamFile(path.join(root, entry.name, "team.json")));
        } catch {
          // A partially written or manually damaged team is skipped from list,
          // while direct get still surfaces the precise error.
        }
      }
    }
    return teams
      .map(toSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(team: TeamRecord): Promise<TeamRecord> {
    return this.withLock(team.id, async () => {
      team.updatedAt = new Date().toISOString();
      await this.writeJsonAtomic(
        path.join(this.teamDirectory(team.id), "team.json"),
        team,
      );
      return structuredClone(team);
    });
  }

  async update(
    teamId: string,
    mutator: (team: TeamRecord) => void | Promise<void>,
  ): Promise<TeamRecord> {
    return this.withLock(teamId, async () => {
      const team = await this.readTeamFile(
        path.join(this.teamDirectory(teamId), "team.json"),
      );
      await mutator(team);
      team.updatedAt = new Date().toISOString();
      await this.writeJsonAtomic(
        path.join(this.teamDirectory(teamId), "team.json"),
        team,
      );
      return structuredClone(team);
    });
  }

  async appendEvent(event: TeamEvent): Promise<void> {
    await appendFile(
      path.join(this.teamDirectory(event.teamId), "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  async appendMessage(teamId: string, message: TeamMessage): Promise<void> {
    const inbox = path.join(
      this.teamDirectory(teamId),
      "inbox",
      `${message.to}.jsonl`,
    );
    await appendFile(inbox, `${JSON.stringify(message)}\n`, "utf8");
  }

  async readMessages(teamId: string, recipient: string): Promise<TeamMessage[]> {
    try {
      const content = await readFile(
        path.join(this.teamDirectory(teamId), "inbox", `${recipient}.jsonl`),
        "utf8",
      );
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TeamMessage);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async archive(teamId: string): Promise<TeamRecord> {
    return this.withLock(teamId, async () => {
      const team = await this.readTeamFile(
        path.join(this.teamDirectory(teamId), "team.json"),
      );
      team.status = "archived";
      team.updatedAt = new Date().toISOString();
      await this.writeJsonAtomic(
        path.join(this.teamDirectory(teamId), "team.json"),
        team,
      );
      await rename(this.teamDirectory(teamId), this.archiveDirectory(teamId));
      return structuredClone(team);
    });
  }

  teamDirectory(teamId: string): string {
    assertSafeId(teamId);
    return path.join(this.teamsRoot, teamId);
  }

  archiveDirectory(teamId: string): string {
    assertSafeId(teamId);
    return path.join(this.archiveRoot, teamId);
  }

  private async readTeamFile(file: string): Promise<TeamRecord> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        throw new AgentTeamsError(`找不到团队状态：${file}`, "TEAM_NOT_FOUND");
      }
      throw error;
    }
    const team = JSON.parse(raw) as TeamRecord;
    invariant(
      team.schemaVersion === TEAM_SCHEMA_VERSION,
      `不支持的团队状态版本：${String(team.schemaVersion)}`,
      "UNSUPPORTED_SCHEMA",
    );
    return team;
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function assertSafeId(id: string): void {
  invariant(
    /^[a-zA-Z0-9_-]+$/.test(id),
    "标识符只能包含字母、数字、下划线和连字符",
    "INVALID_ID",
    { id },
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function toSummary(team: TeamRecord): TeamSummary {
  const taskCounts = Object.fromEntries(
    TASK_STATUSES.map((status) => [status, 0]),
  ) as Record<TaskStatus, number>;
  for (const task of team.tasks) taskCounts[task.status] += 1;
  return {
    id: team.id,
    name: team.name,
    goal: team.goal,
    status: team.status,
    memberCount: team.members.filter((member) => member.status !== "removed").length,
    taskCounts,
    updatedAt: team.updatedAt,
  };
}
