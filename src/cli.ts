#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Cursor } from "@cursor/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStateStore } from "./core/state-store.js";
import { DashboardServer } from "./dashboard/server.js";
import { errorMessage } from "./domain/errors.js";
import { createAgentTeamsServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const workspace = option(args, "--workspace") ?? process.cwd();

  switch (command) {
    case "mcp": {
      const app = await createAgentTeamsServer(path.resolve(workspace));
      await app.server.connect(new StdioServerTransport());
      console.error(`[cursor-agent-teams] MCP ready for ${path.resolve(workspace)}`);
      return;
    }
    case "dashboard": {
      const store = new FileStateStore(path.resolve(workspace));
      await store.initialize();
      const portValue = option(args, "--port");
      const dashboard = new DashboardServer(store, {
        port: portValue ? Number(portValue) : 43117,
      });
      const url = await dashboard.start();
      console.log(url);
      return;
    }
    case "doctor": {
      const store = new FileStateStore(path.resolve(workspace));
      await store.initialize();
      console.log(
        JSON.stringify(
          {
            node: process.version,
            workspace: store.workspace,
            stateRoot: store.stateRoot,
            cursorApiKey: process.env.CURSOR_API_KEY ? "configured" : "missing",
            model: process.env.CURSOR_MODEL ?? "auto",
            teams: (await store.list(true)).length,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "login": {
      const result = await Cursor.auth.login({
        apiKeyName: "cursor-agent-teams",
        openBrowser: !args.includes("--no-browser"),
        onLoginUrl: (url) => {
          console.error(`请在浏览器完成 Cursor SDK 登录：\n${url}`);
        },
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "auth-status": {
      console.log(JSON.stringify(await Cursor.auth.status(), null, 2));
      return;
    }
    case "models": {
      const models = await Cursor.models.list(
        process.env.CURSOR_API_KEY
          ? { apiKey: process.env.CURSOR_API_KEY }
          : undefined,
      );
      console.log(
        models
          .map((model) => `${model.id}\t${model.displayName}`)
          .join("\n"),
      );
      return;
    }
    case "hook": {
      const input = JSON.parse(await readStdin()) as Record<string, unknown>;
      const roots = Array.isArray(input.workspace_roots)
        ? input.workspace_roots.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const hookWorkspace = roots[0] ?? process.cwd();
      const stateRoot = path.join(hookWorkspace, ".cursor-agent-teams");
      await mkdir(stateRoot, { recursive: true });
      await appendFile(
        path.join(stateRoot, "cursor-hooks.jsonl"),
        `${JSON.stringify({ ...input, recorded_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      const output =
        input.hook_event_name === "subagentStart"
          ? { permission: "allow" }
          : {};
      process.stdout.write(`${JSON.stringify(output)}\n`);
      return;
    }
    default:
      printHelp();
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`Cursor Agent Teams

Usage:
  cursor-agent-teams mcp --workspace <path>
  cursor-agent-teams dashboard --workspace <path> [--port 43117]
  cursor-agent-teams doctor --workspace <path>
  cursor-agent-teams hook
  cursor-agent-teams login
  cursor-agent-teams login --no-browser
  cursor-agent-teams auth-status
  cursor-agent-teams models

Environment:
  CURSOR_API_KEY                         Cursor SDK API key
  CURSOR_MODEL                           Default member model (default: auto)
  CURSOR_AGENT_TEAMS_LOAD_SETTINGS       Load project/plugin/team settings (1/0)
  CURSOR_AGENT_TEAMS_MAX_MEMBERS         Team member limit
  CURSOR_AGENT_TEAMS_MAX_REPAIR_ROUNDS   Quality repair loop limit
`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
