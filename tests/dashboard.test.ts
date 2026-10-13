import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateStore } from "../src/core/state-store.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { TEAM_SCHEMA_VERSION, type TeamRecord } from "../src/domain/types.js";

describe("DashboardServer", () => {
  it("serves dashboard assets and persisted team state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cat-dashboard-"));
    const store = new FileStateStore(directory);
    await store.initialize();
    const timestamp = new Date().toISOString();
    const team: TeamRecord = {
      schemaVersion: TEAM_SCHEMA_VERSION,
      id: "team_dashboard",
      name: "Dashboard test",
      goal: "Expose state",
      workspace: directory,
      status: "draft",
      approval: "required",
      members: [],
      tasks: [],
      nextSequence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.create(team);
    const dashboard = new DashboardServer(store, { port: 0 });

    try {
      const url = await dashboard.start();
      const teams = (await fetch(`${url}/api/teams`).then((response) =>
        response.json(),
      )) as Array<{ id: string }>;
      expect(teams[0]!.id).toBe("team_dashboard");

      const html = await fetch(url).then((response) => response.text());
      expect(html).toContain("协作调度台");

      const css = await fetch(`${url}/styles.css`).then((response) =>
        response.text(),
      );
      expect(css).toContain("--signal");
    } finally {
      await dashboard.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
