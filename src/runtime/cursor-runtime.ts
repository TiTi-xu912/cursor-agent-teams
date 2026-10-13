import { Agent } from "@cursor/sdk";
import type {
  AgentOptions,
  ModelSelection,
  Run,
  SDKAgent,
  SDKCustomTool,
  SDKJsonValue,
  ToolName,
} from "@cursor/sdk";
import { createId, now } from "../domain/ids.js";
import type {
  AgentRuntime,
  RuntimeResult,
  RuntimeTask,
  TaskResult,
  TeamMessage,
} from "../domain/types.js";
import { errorMessage } from "../domain/errors.js";
import { FileStateStore } from "../core/state-store.js";

export interface CursorRuntimeOptions {
  apiKey?: string;
  loadCursorSettings?: boolean;
  preventNestedAgents?: boolean;
}

export class CursorRuntime implements AgentRuntime {
  private readonly activeRuns = new Map<string, Run>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: FileStateStore,
    private readonly options: CursorRuntimeOptions = {},
  ) {}

  async execute(
    input: RuntimeTask,
    onStarted?: (ids: { agentId: string; runId: string }) => Promise<void>,
  ): Promise<RuntimeResult> {
    if (!input.member.readonly) {
      return this.withWriterLock(() => this.executeAgent(input, onStarted));
    }
    return this.executeAgent(input, onStarted);
  }

  async cancel(agentId: string, runId?: string): Promise<void> {
    if (!agentId) return;
    const run = this.activeRuns.get(agentId);
    if (run && (!runId || run.id === runId) && run.supports("cancel")) {
      await run.cancel();
      return;
    }
    if (runId) {
      try {
        await Agent.cancelRun(runId, {
          runtime: "local",
          cwd: this.store.workspace,
        });
      } catch {
        // The run may already be terminal; cancellation is best effort.
      }
    }
  }

  private async executeAgent(
    input: RuntimeTask,
    onStarted?: (ids: { agentId: string; runId: string }) => Promise<void>,
  ): Promise<RuntimeResult> {
    let agent: SDKAgent | undefined;
    try {
      const options = this.agentOptions(input);
      agent = input.member.agentId
        ? await Agent.resume(input.member.agentId, options)
        : await Agent.create(options);
      const run = await agent.send(buildPrompt(input), {
        mode: "agent",
        local: { force: true },
      });
      this.activeRuns.set(agent.agentId, run);
      await onStarted?.({ agentId: agent.agentId, runId: run.id });
      const result = await run.wait();
      if (result.status !== "finished") {
        return {
          agentId: agent.agentId,
          runId: run.id,
          status: result.status === "cancelled" ? "cancelled" : "failed",
          error: result.error?.message ?? `Cursor run ${result.status}`,
        };
      }
      return {
        agentId: agent.agentId,
        runId: run.id,
        status: "completed",
        result: parseTaskResult(result.result ?? ""),
      };
    } catch (error) {
      return {
        agentId: agent?.agentId ?? input.member.agentId ?? "unavailable",
        runId: "unavailable",
        status: "failed",
        error: errorMessage(error),
      };
    } finally {
      if (agent) {
        this.activeRuns.delete(agent.agentId);
        await agent[Symbol.asyncDispose]();
      }
    }
  }

  private agentOptions(input: RuntimeTask): AgentOptions {
    const tools = resolveTools(input);
    const customTools = this.customTools(input);
    return {
      name: `${input.teamId}/${input.member.name}`,
      model: modelSelection(input.member.model, input.member.reasoningEffort),
      local: {
        cwd: input.workspace,
        settingSources: this.options.loadCursorSettings
          ? ["project", "plugins", "team"]
          : [],
        customTools,
        enableAgentRetries: true,
      },
      ...(tools ? { tools } : {}),
      ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      ...(this.options.preventNestedAgents === false
        ? {}
        : { disallowedTools: ["task"] }),
    };
  }

  private customTools(input: RuntimeTask): Record<string, SDKCustomTool> {
    return {
      agent_teams_send_message: {
        description: "Send a durable message to the captain or another team member.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "body"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const to = String(args.to ?? "");
          const body = String(args.body ?? "").trim();
          const team = await this.store.get(input.teamId);
          const recipients = new Set([
            "captain",
            ...team.members.map((member) => member.id),
          ]);
          if (!recipients.has(to)) return { error: `Unknown recipient: ${to}` };
          if (!body) return { error: "Message body is empty" };
          const message: TeamMessage = {
            id: createId("message"),
            from: input.member.id,
            to,
            body,
            taskId: input.task.id,
            createdAt: now(),
          };
          await this.store.appendMessage(input.teamId, message);
          return { delivered: true, messageId: message.id };
        },
      },
      agent_teams_read_messages: {
        description: "Read durable messages addressed to this member.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () =>
          toSdkJson(await this.store.readMessages(input.teamId, input.member.id)),
      },
      agent_teams_status: {
        description: "Read the current persisted team and task state.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => toSdkJson(await this.store.get(input.teamId)),
      },
    };
  }

  private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function resolveTools(input: RuntimeTask): ToolName[] | undefined {
  const policy = input.member.toolPolicy;
  if (policy?.allow) return [...new Set([...policy.allow, "mcp"])];

  const readonlyTools: ToolName[] = [
    "read",
    "grep",
    "glob",
    "ls",
    "webSearch",
    "webFetch",
    "mcp",
    "readLints",
  ];
  if (input.member.readonly) {
    return readonlyTools.filter((tool) => !policy?.deny?.includes(tool));
  }
  if (!policy?.deny?.length) return undefined;
  const defaults: ToolName[] = [
    "shell",
    "read",
    "edit",
    "grep",
    "glob",
    "ls",
    "mcp",
    "webSearch",
    "webFetch",
    "delete",
    "readLints",
  ];
  return defaults.filter((tool) => !policy.deny?.includes(tool));
}

function modelSelection(model: string, effort?: string): ModelSelection {
  return {
    id: model,
    ...(effort
      ? { params: [{ id: "reasoning_effort", value: effort }] }
      : {}),
  };
}

function buildPrompt(input: RuntimeTask): string {
  const dependencyContext = input.dependencyResults.length
    ? input.dependencyResults
        .map(
          (dependency) =>
            `- ${dependency.subject} (${dependency.taskId}): ${JSON.stringify(dependency.result ?? {})}`,
        )
        .join("\n")
    : "- 无";
  return `你是团队成员「${input.member.name}」。

角色：${input.member.role}
团队目标：${input.teamGoal}
当前任务：${input.task.subject}
任务类型：${input.task.kind}
任务说明：${input.task.description}
目标：${input.task.objective ?? input.task.description}
验收标准：${JSON.stringify(input.task.acceptance ?? [])}
范围内：${JSON.stringify(input.task.inScope ?? [])}
范围外：${JSON.stringify(input.task.outOfScope ?? [])}
验证命令：${JSON.stringify(input.task.verify ?? [])}

依赖任务产物：
${dependencyContext}

要求：
1. 只处理当前任务，不擅自扩大范围。
2. 写任务可以直接修改当前工作区；只读任务不得修改文件。
3. 需要协作时使用 agent_teams_send_message，先读取 agent_teams_read_messages。
4. 执行必要验证，不要伪造命令结果。
5. 最终回复必须包含且只包含以下标记包围的 JSON：

<AGENT_TEAMS_RESULT>
{
  "summary": "完成情况",
  "output": "可传递给下游的详细结果",
  "verdict": "pass",
  "findings": [],
  "acceptanceResults": [{"criterion": "原验收标准文本", "passed": true, "evidence": "证据"}],
  "commandsRun": [],
  "changedPaths": []
}
</AGENT_TEAMS_RESULT>

verdict 仅可为 pass、needs_revision 或 reject。没有对应字段时可省略，但 summary 必须提供。`;
}

function parseTaskResult(text: string): TaskResult {
  const tagged = text.match(
    /<AGENT_TEAMS_RESULT>\s*([\s\S]*?)\s*<\/AGENT_TEAMS_RESULT>/,
  )?.[1];
  const candidate = tagged ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return { summary: text.trim() || "任务已完成" };
  try {
    const parsed = JSON.parse(candidate) as TaskResult;
    if (!parsed.summary) parsed.summary = "任务已完成";
    return parsed;
  } catch {
    return { summary: text.trim() || "任务已完成", output: text };
  }
}

function toSdkJson(value: unknown): SDKJsonValue {
  return JSON.parse(JSON.stringify(value)) as SDKJsonValue;
}
