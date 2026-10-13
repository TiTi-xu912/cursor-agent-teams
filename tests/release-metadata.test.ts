import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("release metadata", () => {
  it("keeps npm and Cursor Plugin versions aligned", async () => {
    const packageJson = await json("package.json");
    const pluginJson = await json(".cursor-plugin/plugin.json");

    expect(pluginJson.version).toBe(packageJson.version);
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository.url).toContain(
      "TiTi-xu912/cursor-agent-teams",
    );
    expect(pluginJson.homepage).toContain("TiTi-xu912/cursor-agent-teams");
  });

  it("excludes local state and planning notes from git", async () => {
    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    for (const entry of [
      ".cursor/",
      ".cursor-agent-teams/",
      ".env",
      "task_plan.md",
      "findings.md",
      "progress.md",
    ]) {
      expect(gitignore).toContain(entry);
    }
  });

  it("retains upstream attribution", async () => {
    const license = await readFile(path.join(root, "LICENSE"), "utf8");
    const notice = await readFile(path.join(root, "NOTICE.md"), "utf8");
    expect(license).toContain("程序员阿江(Relakkes)");
    expect(notice).toContain("NanmiCoder/dsh-agent-teams");
  });
});

async function json(file: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}
