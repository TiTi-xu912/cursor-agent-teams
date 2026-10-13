#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FileStateStore } from "../core/state-store.js";
import { TeamService } from "../core/team-service.js";
import { DashboardServer } from "../dashboard/server.js";
import { AgentTeamsError, errorMessage } from "../domain/errors.js";
import { CursorRuntime } from "../runtime/cursor-runtime.js";

const taskKinds = [
  "work",
  "requirements",
  "implementation",
  "verification",
  "review",
  "repair",
  "integration",
] as const;

export interface AgentTeamsServer {
  server: McpServer;
  dashboard: DashboardServer;
  close(): Promise<void>;
}

export async function createAgentTeamsServer(
  workspace: string,
): Promise<AgentTeamsServer> {
  const store = new FileStateStore(path.resolve(workspace));
  await store.initialize();
  const runtime = new CursorRuntime(store, {
    ...(process.env.CURSOR_API_KEY
      ? { apiKey: process.env.CURSOR_API_KEY }
      : {}),
    loadCursorSettings: process.env.CURSOR_AGENT_TEAMS_LOAD_SETTINGS === "1",
    preventNestedAgents: process.env.CURSOR_AGENT_TEAMS_ALLOW_NESTED !== "1",
  });
  const service = new TeamService(store, runtime, {
    defaultModel: process.env.CURSOR_MODEL ?? "auto",
    maxMembers: numberEnv("CURSOR_AGENT_TEAMS_MAX_MEMBERS", 8),
    maxRepairRounds: numberEnv("CURSOR_AGENT_TEAMS_MAX_REPAIR_ROUNDS", 2),
  });
  const dashboard = new DashboardServer(store, {
    host: process.env.CURSOR_AGENT_TEAMS_DASHBOARD_HOST ?? "127.0.0.1",
    port: numberEnv("CURSOR_AGENT_TEAMS_DASHBOARD_PORT", 43117),
  });
  const server = new McpServer({
    name: "cursor-agent-teams",
    version: "0.1.0",
  });

  server.registerResource(
    "agent-teams-state",
    "agent-teams://state",
    {
      title: "Cursor Agent Teams state",
      description: "Persisted team summaries in the current workspace",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await store.list(true), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "agent_teams_list",
    {
      title: "List agent teams",
      description: "List active and archived teams in this workspace.",
      inputSchema: {
        include_archived: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(async ({ include_archived }) => store.list(include_archived)),
  );

  server.registerTool(
    "agent_teams_create",
    {
      title: "Create agent team draft",
      description:
        "Create a staged team. Add members and tasks, then explicitly approve it.",
      inputSchema: {
        name: z.string().min(1),
        goal: z.string().min(1),
        approval: z.enum(["required", "automatic"]).default("required"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeTool(async ({ name, goal, approval }) =>
      service.createTeam({ name, goal, workspace: store.workspace, approval }),
    ),
  );

  server.registerTool(
    "agent_teams_add_member",
    {
      title: "Add team member",
      description: "Add a role-specific Cursor SDK member to a draft team.",
      inputSchema: {
        team_id: z.string(),
        name: z.string().min(1),
        role: z.string().min(1),
        model: z.string().default(process.env.CURSOR_MODEL ?? "auto"),
        reasoning_effort: z.string().optional(),
        readonly: z.boolean().default(false),
        background: z.boolean().default(false),
        allow_tools: z.array(z.string()).optional(),
        deny_tools: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      async ({
        team_id,
        name,
        role,
        model,
        reasoning_effort,
        readonly,
        background,
        allow_tools,
        deny_tools,
      }) =>
        service.addMember(team_id, {
          name,
          role,
          model,
          readonly,
          background,
          ...(reasoning_effort ? { reasoningEffort: reasoning_effort } : {}),
          ...(allow_tools
            ? { toolPolicy: { allow: allow_tools } }
            : deny_tools
              ? { toolPolicy: { deny: deny_tools } }
              : {}),
        }),
    ),
  );

  server.registerTool(
    "agent_teams_create_task",
    {
      title: "Create team task",
      description:
        "Create a dependency-aware task. Quality task kinds require contracts.",
      inputSchema: {
        team_id: z.string(),
        subject: z.string().min(1),
        description: z.string().min(1),
        kind: z.enum(taskKinds).default("work"),
        dependencies: z.array(z.string()).default([]),
        assignee: z.string().optional(),
        objective: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        in_scope: z.array(z.string()).optional(),
        out_of_scope: z.array(z.string()).optional(),
        verify: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      async ({
        team_id,
        subject,
        description,
        kind,
        dependencies,
        assignee,
        objective,
        acceptance,
        in_scope,
        out_of_scope,
        verify,
      }) =>
        service.createTask(team_id, {
          subject,
          description,
          kind,
          dependencies,
          ...(assignee ? { assignee } : {}),
          ...(objective ? { objective } : {}),
          ...(acceptance ? { acceptance } : {}),
          ...(in_scope ? { inScope: in_scope } : {}),
          ...(out_of_scope ? { outOfScope: out_of_scope } : {}),
          ...(verify ? { verify } : {}),
        }),
    ),
  );

  server.registerTool(
    "agent_teams_approve",
    {
      title: "Approve and run team",
      description:
        "Approve the staged roster and task graph, then begin automatic scheduling.",
      inputSchema: { team_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safeTool(async ({ team_id }) => service.approve(team_id)),
  );

  server.registerTool(
    "agent_teams_status",
    {
      title: "Get team status",
      description: "Read the complete persisted team, member and task state.",
      inputSchema: { team_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(async ({ team_id }) => service.status(team_id)),
  );

  server.registerTool(
    "agent_teams_recover",
    {
      title: "Recover interrupted team",
      description:
        "Mark stranded attempts for safe retry and restart scheduling after a process interruption.",
      inputSchema: { team_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool(async ({ team_id }) => service.recover(team_id)),
  );

  server.registerTool(
    "agent_teams_reassign_task",
    {
      title: "Reassign task",
      description:
        "Cancel the current attempt if necessary and atomically assign the task to another member.",
      inputSchema: {
        team_id: z.string(),
        task_id: z.string(),
        member_id: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    safeTool(async ({ team_id, task_id, member_id }) =>
      service.reassignTask(team_id, task_id, member_id),
    ),
  );

  server.registerTool(
    "agent_teams_send_message",
    {
      title: "Send team message",
      description:
        "Write a durable message to the captain or a team member mailbox.",
      inputSchema: {
        team_id: z.string(),
        from: z.string(),
        to: z.string(),
        body: z.string().min(1),
        task_id: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeTool(async ({ team_id, from, to, body, task_id }) =>
      service.sendMessage(team_id, from, to, body, task_id),
    ),
  );

  server.registerTool(
    "agent_teams_read_messages",
    {
      title: "Read team messages",
      description: "Read a captain or member durable mailbox.",
      inputSchema: {
        team_id: z.string(),
        recipient: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(async ({ team_id, recipient }) =>
      store.readMessages(team_id, recipient),
    ),
  );

  server.registerTool(
    "agent_teams_halt",
    {
      title: "Stop team",
      description:
        "Cancel active attempts, freeze scheduling and preserve all state.",
      inputSchema: {
        team_id: z.string(),
        reason: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    safeTool(async ({ team_id, reason }) => service.halt(team_id, reason)),
  );

  server.registerTool(
    "agent_teams_resume",
    {
      title: "Resume stopped team",
      description: "Resume a halted team with an explicit reason.",
      inputSchema: {
        team_id: z.string(),
        reason: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safeTool(async ({ team_id, reason }) => service.resume(team_id, reason)),
  );

  server.registerTool(
    "agent_teams_archive",
    {
      title: "Archive team",
      description:
        "Move a non-running team into immutable history while retaining tasks and mailboxes.",
      inputSchema: { team_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    safeTool(async ({ team_id }) => service.archive(team_id)),
  );

  server.registerTool(
    "agent_teams_dashboard",
    {
      title: "Open team dashboard",
      description:
        "Start the local read-only status dashboard and return its URL.",
      inputSchema: { team_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(async ({ team_id }) => {
      const url = await dashboard.start();
      return {
        url: team_id ? `${url}/?team=${encodeURIComponent(team_id)}` : url,
      };
    }),
  );

  return {
    server,
    dashboard,
    async close() {
      await Promise.allSettled([server.close(), dashboard.close()]);
    },
  };
}

function safeTool<T extends Record<string, unknown>>(
  operation: (input: T) => Promise<unknown>,
) {
  return async (input: T) => {
    try {
      const value = await operation(input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: normalizeStructured(value),
      };
    } catch (error) {
      const payload = {
        error: errorMessage(error),
        ...(error instanceof AgentTeamsError
          ? { code: error.code, details: error.details }
          : {}),
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  };
}

function normalizeStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseWorkspace(argv: string[]): string {
  const index = argv.indexOf("--workspace");
  const candidate = index >= 0 ? argv[index + 1] : undefined;
  return candidate ? path.resolve(candidate) : process.cwd();
}

async function main(): Promise<void> {
  const workspace = parseWorkspace(process.argv.slice(2));
  const app = await createAgentTeamsServer(workspace);
  const transport = new StdioServerTransport();
  await app.server.connect(transport);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error(`[cursor-agent-teams] MCP ready for ${workspace}`);
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`[cursor-agent-teams] ${errorMessage(error)}`);
    process.exit(1);
  });
}
