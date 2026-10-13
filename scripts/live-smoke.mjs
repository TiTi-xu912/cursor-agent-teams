import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(root, "dist", "src", "cli.js"),
    "mcp",
    "--workspace",
    root,
  ],
  cwd: root,
  stderr: "pipe",
});
const client = new Client({
  name: "cursor-agent-teams-live-smoke",
  version: "0.1.0",
});

let teamId;

try {
  await client.connect(transport);
  const created = await call("agent_teams_create", {
    name: `live-smoke-${Date.now()}`,
    goal: "Read this repository and return a concise architecture summary without modifying files.",
  });
  teamId = created.id;

  const withMember = await call("agent_teams_add_member", {
    team_id: teamId,
    name: "smoke-reader",
    role: "Read README.md and docs/architecture.md, then report the major components and one operational risk. Do not edit files.",
    model: "auto",
    readonly: true,
    background: false,
  });
  const memberId = withMember.members.at(-1).id;

  await call("agent_teams_create_task", {
    team_id: teamId,
    subject: "Summarize architecture",
    description:
      "Read README.md and docs/architecture.md. Return the main components and one concrete operational risk. Do not modify files.",
    kind: "work",
    dependencies: [],
    assignee: memberId,
  });
  await call("agent_teams_approve", { team_id: teamId });

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const team = await call("agent_teams_status", { team_id: teamId });
    if (team.status === "completed") {
      const result = team.tasks[0]?.result;
      console.log(JSON.stringify({ teamId, status: team.status, result }, null, 2));
      await call("agent_teams_archive", { team_id: teamId });
      process.exitCode = 0;
      break;
    }
    if (team.status === "halted") {
      throw new Error(`Team halted: ${team.haltedReason ?? "unknown reason"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (process.exitCode === undefined) {
    throw new Error("Live smoke test timed out");
  }
} catch (error) {
  if (teamId) {
    try {
      const team = await call("agent_teams_status", { team_id: teamId });
      if (team.status === "running") {
        await call("agent_teams_halt", {
          team_id: teamId,
          reason: "Live smoke test cleanup",
        });
      }
    } catch {
      // Keep the original smoke error.
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.close();
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent;
}
