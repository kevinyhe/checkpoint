import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertViewerFiles, renderRunViewerHtmlForTest, startRunViewerServer, type StartedRunViewer } from "../src/viewer-server.js";

let viewer: StartedRunViewer | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  if (viewer) {
    await new Promise<void>((resolve) => viewer?.server.close(() => resolve()));
    viewer = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("run viewer server", () => {
  it("rejects missing viewer input files", async () => {
    await expect(
      assertViewerFiles({
        romPath: "missing.nes",
        statePath: "missing.state.json",
        runPath: "missing.playtest.json"
      })
    ).rejects.toThrow("ROM file does not exist");
  });

  it("serves only whitelisted viewer routes", async () => {
    const files = await createViewerFixtures();
    viewer = await startRunViewerServer({ ...files, port: 4180 });

    const ok = await fetch(`${viewer.url}`);
    const traversal = await fetch(`http://127.0.0.1:${viewer.port}/../../package.json`);
    const episodes = await fetch(`http://127.0.0.1:${viewer.port}/api/episodes`);

    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("PlaytestIQ Run Viewer");
    expect(episodes.status).toBe(200);
    expect(await episodes.text()).toContain("\"episode\":1");
    expect(traversal.status).toBe(404);
  });

  it("rejects episode sidecar paths that escape the run directory", async () => {
    const files = await createViewerFixtures({ episodeLogPath: "../outside.jsonl" });

    await expect(startRunViewerServer({ ...files, port: 4181 })).rejects.toThrow("Episode log path escapes");
  });

  it("falls back cleanly when no episode sidecar exists", async () => {
    const files = await createViewerFixtures({ includeEpisodeLog: false });
    viewer = await startRunViewerServer({ ...files, port: 4182 });

    const episodes = await fetch(`http://127.0.0.1:${viewer.port}/api/episodes`);

    expect(episodes.status).toBe(204);
  });

  it("includes synced overlay and grid viewer controls", async () => {
    const html = await renderRunViewerHtmlForTest();

    expect(html).toContain("viewModeSelect");
    expect(html).toContain("Overlay trails");
    expect(html).toContain("ghostOverlay");
    expect(html).toContain("overlayLimitSelect");
    expect(html).toContain("trailLengthSelect");
    expect(html).toContain("drawGhostOverlay");
    expect(html).toContain("levelPage");
    expect(html).toContain("Grid replays");
    expect(html).toContain("gridViewer");
    expect(html).toContain("stepGridFrame");
    expect(html).toContain("gridSizeSelect");
    expect(html).toContain("Coverage");
    expect(html).toContain("Fastest");
    expect(html).toContain("Game Score");
    expect(html).toContain("Rooms");
    expect(html).toContain("coverageGoal");
    expect(html).toContain("/api/episodes");
  });
});

async function createViewerFixtures(options: { includeEpisodeLog?: boolean; episodeLogPath?: string } = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "playtestiq-viewer-"));
  const romPath = join(tempDir, "smb.nes");
  const statePath = join(tempDir, "world-4-2.state.json");
  const runPath = join(tempDir, "run.playtest.json");
  const episodeLogPath = options.episodeLogPath ?? "run.playtest.episodes.jsonl";
  const includeEpisodeLog = options.includeEpisodeLog ?? true;

  await writeFile(romPath, new Uint8Array([0x4e, 0x45, 0x53, 0x1a]));
  await writeFile(statePath, JSON.stringify({ cpu: {}, mmap: {}, ppu: {}, papu: {} }));
  if (includeEpisodeLog && !episodeLogPath.startsWith("..")) {
    await writeFile(join(tempDir, episodeLogPath), `${JSON.stringify({ episode: 1, session: { persona: "coverage-explorer" }, overlaySamples: [] })}\n`);
  }
  await writeFile(
    runPath,
    JSON.stringify({
      run: {
        id: "run_test",
        objective: "world-4-2-known-glitches",
        durationSeconds: 1,
        seed: 1
      },
      discovery: includeEpisodeLog
        ? {
            episodeLog: {
              format: "jsonl",
              path: episodeLogPath,
              episodes: 1
            }
          }
        : undefined,
      sessions: []
    })
  );

  return { romPath, statePath, runPath };
}
