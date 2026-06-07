import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadableFile, readJsonFile } from "./files.js";
import type { RunResult } from "./types.js";

export interface RunViewerOptions {
  romPath: string;
  statePath: string;
  runPath: string;
  episodesPath?: string;
  port?: number;
}

export interface StartedRunViewer {
  url: string;
  port: number;
  server: Server;
}

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VIEWER_HTML_PATH = resolve(PROJECT_ROOT, "tools", "run-viewer.html");
const JSNES_PATH = resolve(PROJECT_ROOT, "node_modules", "jsnes", "dist", "jsnes.js");

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".nes", "application/octet-stream"]
]);

export async function assertViewerFiles(options: RunViewerOptions): Promise<void> {
  await assertReadableFile(options.romPath, "ROM");
  await assertReadableFile(options.statePath, "Save state");
  await assertReadableFile(options.runPath, "Run");
  await assertReadableFile(VIEWER_HTML_PATH, "Run viewer HTML");
  await assertReadableFile(JSNES_PATH, "JSNES runtime");
  await readJsonFile(options.statePath, "Save state");
  const run = (await readJsonFile(options.runPath, "Run")) as Partial<RunResult>;
  const episodeLogPath = resolveViewerEpisodeLogPath(options.runPath, run, options.episodesPath);
  if (episodeLogPath) {
    await assertReadableFile(episodeLogPath, "Episode log");
  }
}

export async function startRunViewerServer(options: RunViewerOptions): Promise<StartedRunViewer> {
  await assertViewerFiles(options);
  const handler = createRunViewerRequestHandler(options);
  const server = createServer(handler);
  const port = await listenOnAvailablePort(server, options.port ?? 4174);

  return {
    url: `http://127.0.0.1:${port}/tools/run-viewer.html`,
    port,
    server
  };
}

export function createRunViewerRequestHandler(options: RunViewerOptions) {
  let episodeLogPath: string | undefined;
  try {
    const runText = requireRunJsonSync(options.runPath);
    episodeLogPath = resolveViewerEpisodeLogPath(options.runPath, JSON.parse(runText) as Partial<RunResult>, options.episodesPath);
  } catch {
    episodeLogPath = options.episodesPath ? resolve(options.episodesPath) : undefined;
  }

  const files = new Map<string, { path: string; contentType?: string }>([
    ["/", { path: VIEWER_HTML_PATH }],
    ["/tools/run-viewer.html", { path: VIEWER_HTML_PATH }],
    ["/vendor/jsnes.js", { path: JSNES_PATH }],
    ["/api/rom", { path: resolve(options.romPath), contentType: "application/octet-stream" }],
    ["/api/state", { path: resolve(options.statePath), contentType: "application/json; charset=utf-8" }],
    ["/api/run", { path: resolve(options.runPath), contentType: "application/json; charset=utf-8" }]
  ]);
  if (episodeLogPath) {
    files.set("/api/episodes", { path: episodeLogPath, contentType: "application/x-ndjson; charset=utf-8" });
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = files.get(requestUrl.pathname);

    if (!route) {
      if (requestUrl.pathname === "/api/episodes") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }

    try {
      const contentType = route.contentType ?? CONTENT_TYPES.get(extname(route.path)) ?? "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store"
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      createReadStream(route.path).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  };
}

function resolveViewerEpisodeLogPath(runPath: string, run: Partial<RunResult>, explicitPath?: string): string | undefined {
  if (explicitPath) {
    return resolve(explicitPath);
  }

  const logPath = run.discovery?.episodeLog?.path;
  if (!logPath) {
    return undefined;
  }

  if (isAbsolute(logPath)) {
    return logPath;
  }

  const runDir = dirname(resolve(runPath));
  const resolved = resolve(runDir, logPath);
  if (!isPathInside(runDir, resolved)) {
    throw new Error(`Episode log path escapes the run directory: ${logPath}`);
  }

  return resolved;
}

function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function requireRunJsonSync(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

export async function renderRunViewerHtmlForTest(): Promise<string> {
  return readFile(VIEWER_HTML_PATH, "utf8");
}

async function listenOnAvailablePort(server: Server, startPort: number): Promise<number> {
  let port = startPort;

  while (port < startPort + 50) {
    const result = await tryListen(server, port);
    if (result === "listening") {
      return port;
    }

    port += 1;
  }

  throw new Error(`Could not find an available viewer port starting at ${startPort}.`);
}

function tryListen(server: Server, port: number): Promise<"listening" | "busy"> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolvePromise("busy");
        return;
      }
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolvePromise("listening");
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
