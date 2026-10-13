import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");

if (projectIndex >= 0) {
  const project = args[projectIndex + 1];
  if (!project) throw new Error("--project 需要目标目录");
  await installProject(path.resolve(project));
} else {
  await installLocalPlugin();
}

async function installLocalPlugin() {
  const target = path.join(
    os.homedir(),
    ".cursor",
    "plugins",
    "local",
    "cursor-agent-teams",
  );
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(path.join(root, ".cursor-plugin"), path.join(target, ".cursor-plugin"), {
    recursive: true,
  });
  await cp(path.join(root, "plugin"), path.join(target, "plugin"), {
    recursive: true,
  });
  await cp(path.join(root, "LICENSE"), path.join(target, "LICENSE"));
  console.log(`已安装本地 Cursor Plugin：${target}`);
  console.log("请先确保已运行 npm install -g .，然后重载 Cursor 窗口。");
}

async function installProject(project) {
  const cursor = path.join(project, ".cursor");
  await mkdir(cursor, { recursive: true });
  await copyDirectory("agents", path.join(cursor, "agents"));
  await copyDirectory("rules", path.join(cursor, "rules"));
  await copyDirectory("skills", path.join(cursor, "skills"));
  await copyDirectory("commands", path.join(cursor, "commands"));

  const cli = path.join(root, "dist", "src", "cli.js");
  await mergeMcp(path.join(cursor, "mcp.json"), cli);
  await mergeHooks(path.join(cursor, "hooks.json"), cli);
  console.log(`已安装项目级 Cursor Agent Teams：${project}`);
  console.log("重载 Cursor 后，使用 /agent-teams 或 agent_teams_* MCP 工具。");
}

async function copyDirectory(name, target) {
  await mkdir(target, { recursive: true });
  await cp(path.join(root, "plugin", name), target, {
    recursive: true,
    force: true,
  });
}

async function mergeMcp(file, cli) {
  const config = await readJson(file, { mcpServers: {} });
  config.mcpServers ??= {};
  config.mcpServers["cursor-agent-teams"] = {
    type: "stdio",
    command: process.execPath,
    args: [cli, "mcp", "--workspace", "${workspaceFolder}"],
    env: {
      CURSOR_MODEL: "auto",
      CURSOR_AGENT_TEAMS_DASHBOARD_PORT: "43117",
    },
    envFile: "${workspaceFolder}/.env",
  };
  await writeJson(file, config);
}

async function mergeHooks(file, cli) {
  const config = await readJson(file, { version: 1, hooks: {} });
  config.version = 1;
  config.hooks ??= {};
  const command = `"${process.execPath}" "${cli}" hook`;
  const additions = {
    subagentStart: {
      command,
      matcher: "team-.*",
      timeout: 10,
      failClosed: false,
    },
    subagentStop: {
      command,
      matcher: "team-.*",
      timeout: 10,
      failClosed: false,
      loop_limit: 1,
    },
  };
  for (const [event, hook] of Object.entries(additions)) {
    config.hooks[event] ??= [];
    const exists = config.hooks[event].some(
      (candidate) => candidate.command === command,
    );
    if (!exists) config.hooks[event].push(hook);
  }
  await writeJson(file, config);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
