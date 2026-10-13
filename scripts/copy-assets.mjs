import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "dashboard/index.html",
  "dashboard/styles.css",
  "dashboard/app.js",
  ".cursor-plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/skills/agent-teams/SKILL.md",
];

await Promise.all(required.map((file) => access(path.join(root, file))));
await mkdir(path.join(root, "dist"), { recursive: true });

try {
  await chmod(path.join(root, "dist/src/cli.js"), 0o755);
  await chmod(path.join(root, "dist/src/mcp/server.js"), 0o755);
} catch {
  // Windows and filesystems without POSIX modes do not need chmod.
}
