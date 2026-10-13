import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP server", () => {
  it("publishes team tools and creates a persisted draft", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "cat-mcp-"));
    const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        path.join(project, "src", "mcp", "server.ts"),
        "--workspace",
        workspace,
      ],
      cwd: project,
      stderr: "pipe",
    });
    const client = new Client({
      name: "cursor-agent-teams-test",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "agent_teams_create",
          "agent_teams_add_member",
          "agent_teams_create_task",
          "agent_teams_approve",
          "agent_teams_status",
          "agent_teams_dashboard",
        ]),
      );
      expect(tools.tools).toHaveLength(14);

      const created = await client.callTool({
        name: "agent_teams_create",
        arguments: {
          name: "MCP smoke",
          goal: "Validate protocol wiring",
        },
      });
      expect(created.isError).not.toBe(true);

      const listed = await client.callTool({
        name: "agent_teams_list",
        arguments: { include_archived: false },
      });
      expect(JSON.stringify(listed.content)).toContain("MCP smoke");
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);
});
