import { access, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../domain/errors.js";
import { FileStateStore } from "../core/state-store.js";

export interface DashboardOptions {
  host?: string;
  port?: number;
}

export class DashboardServer {
  private server: Server | undefined;
  private url: string | undefined;

  constructor(
    private readonly store: FileStateStore,
    private readonly options: DashboardOptions = {},
  ) {}

  async start(): Promise<string> {
    if (this.url) return this.url;
    const assets = await findAssetsDirectory();
    const host = this.options.host ?? "127.0.0.1";
    const preferredPort = this.options.port ?? 43117;
    this.server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? `${host}:${preferredPort}`}`,
        );
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (requestUrl.pathname === "/api/teams") {
          sendJson(response, 200, await this.store.list(true));
          return;
        }
        const teamMatch = requestUrl.pathname.match(/^\/api\/teams\/([^/]+)$/);
        if (teamMatch?.[1]) {
          sendJson(response, 200, await this.store.get(teamMatch[1], true));
          return;
        }
        if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
          await sendAsset(response, path.join(assets, "index.html"), "text/html");
          return;
        }
        if (requestUrl.pathname === "/app.js") {
          await sendAsset(
            response,
            path.join(assets, "app.js"),
            "text/javascript",
          );
          return;
        }
        if (requestUrl.pathname === "/styles.css") {
          await sendAsset(response, path.join(assets, "styles.css"), "text/css");
          return;
        }
        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        sendJson(response, 500, { error: errorMessage(error) });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(preferredPort, host, () => resolve());
    });
    const address = this.server.address();
    const port =
      typeof address === "object" && address ? address.port : preferredPort;
    this.url = `http://${host}:${port}`;
    return this.url;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.url = undefined;
  }
}

async function findAssetsDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CURSOR_AGENT_TEAMS_ASSETS,
    path.resolve(moduleDirectory, "../../dashboard"),
    path.resolve(moduleDirectory, "../../../dashboard"),
    path.resolve(process.cwd(), "dashboard"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error("找不到 Dashboard 静态资源目录");
}

async function sendAsset(
  response: import("node:http").ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(file);
  response.writeHead(200, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": body.byteLength,
  });
  response.end(body);
}
