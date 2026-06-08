import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createOverlaySamples,
  createArchiveCell,
  createRouteSeedControllerConfig,
  defaultEpisodeLogPath,
  formatEpisodeLogPathForRun,
  VINE_WARP_TARGET_PROGRESS,
  WallClipTrickController
} from "./discovery.js";
import { executeEpisode, sessionFromExecution } from "./episode.js";
import { readBinaryFile, readJsonFile, readTextFile, sha1, createRunId } from "./files.js";
import { sliceInputRanges } from "./input.js";
import { createSeededRandom } from "./rng.js";
import type { EpisodeLogRecord, Finding, FrameSample, ReproInputRange, RunResult, SmbRamSnapshot } from "./types.js";

export interface WallClipSetupOptions {
  romPath: string;
  statePath: string;
  durationSeconds: number;
  seed: number;
  outPath: string;
  episodeLogPath?: string;
  sourceRunPath?: string;
}

export interface WallClipSetupResult {
  run: RunResult;
  episodeLogPath: string;
}

export async function createWallClipSetupRun(options: WallClipSetupOptions): Promise<WallClipSetupResult> {
  const durationSeconds = normalizePositiveInteger(options.durationSeconds, "duration");
  const seed = normalizeInteger(options.seed, "seed");
  if (options.sourceRunPath) {
    return createWallClipSetupRunFromSource({ ...options, durationSeconds, seed, sourceRunPath: options.sourceRunPath });
  }

  const durationFrames = durationSeconds * 60;
  const { romData, stateData, romSha1, stateSha1 } = await loadInputs(options.romPath, options.statePath);
  const controller = new WallClipTrickController(createSeededRandom(seed), createRouteSeedControllerConfig(seed));

  const execution = executeEpisode({
    romData,
    stateData,
    durationFrames,
    stopOnDeath: true,
    selectButtons: (frame, snapshot) => controller.buttons(frame, snapshot, durationFrames)
  });
  const setupFinding = createWallClipSetupFinding(execution.samples, execution.replayInputs);
  const session = sessionFromExecution("coverage-explorer", execution, [setupFinding]);
  const cells = new Set(execution.samples.map(createArchiveCell));
  const score = Number((session.metrics.maxProgress + setupFinding.frameEnd - setupFinding.frameStart + 260).toFixed(2));
  const episodeLogPath = options.episodeLogPath ?? defaultEpisodeLogPath(options.outPath);
  const episodeLogRunPath = formatEpisodeLogPathForRun(options.outPath, episodeLogPath);

  session.agent = {
    type: "rl-go-explore-hybrid",
    episode: 1,
    episodeId: "episode_1",
    parentId: "wallclip_setup_seed",
    startFrame: 0,
    prefixFrames: 0,
    suffixFrames: session.metrics.frames,
    score,
    newCells: cells.size,
    cellsVisited: execution.samples.length,
    uniqueCells: cells.size,
    bugScore: 100,
    progressScore: session.metrics.maxProgress,
    routeScore: Math.max(0, session.metrics.maxProgress - session.metrics.deaths * 200),
    speedScore: scoreWallClipSetupSpeed(execution.samples, setupFinding.frameStart),
    roomScore: countRooms(execution.samples) * 40,
    gameScore: 0,
    gameScoreDelta: scoreDelta(execution.samples),
    milestoneFrames: {
      "wall-clip-setup": setupFinding.frameStart,
      "wall-pressure": setupFinding.frameEnd
    },
    roomTransitions: Math.max(0, countRooms(execution.samples) - 1),
    roomsReached: [...new Set(execution.samples.map((sample) => sample.roomId))],
    progressDelta: session.metrics.maxProgress,
    targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
    obstacleFrame: setupFinding.frameStart,
    obstacleProgress: Number(setupFinding.evidence.progress ?? session.metrics.maxProgress),
    obstacleDurationFrames: setupFinding.frameEnd - setupFinding.frameStart + 1,
    obstacleReason: "deterministic 4-2 wall-clip setup pressure",
    phase: "go-explore-bug",
    focus: "bugs",
    bugTarget: "wall-clip",
    mutation: "deterministic-4-2-wall-clip-setup"
  };

  const run: RunResult = {
    run: {
      id: createRunId([romSha1, stateSha1, "wallclip-setup", String(durationSeconds), String(seed)]),
      game: "super-mario-bros-nes",
      objective: "world-4-2-known-glitches",
      durationSeconds,
      seed,
      romSha1,
      stateSha1
    },
    discovery: {
      agentType: "rl-go-explore-hybrid",
      strategy: "go-explore",
      focus: "bugs",
      bugTarget: "wall-clip",
      episodes: 1,
      episodeDurationSeconds: durationSeconds,
      top: 1,
      seed,
      workers: 1,
      uniqueCells: cells.size,
      totalFindings: session.findings.length,
      bestScore: score,
      bestSavedScore: score,
      bestProgress: session.metrics.maxProgress,
      targetProgress: VINE_WARP_TARGET_PROGRESS,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      checkpointCount: 0,
      corpusSize: 1,
      episodeLog: {
        format: "jsonl",
        path: episodeLogRunPath,
        episodes: 1
      }
    },
    sessions: [session]
  };

  const record: EpisodeLogRecord = {
    episode: 1,
    session,
    overlaySamples: createOverlaySamples(execution.samples, session.findings)
  };
  await mkdir(dirname(episodeLogPath), { recursive: true });
  await writeFile(episodeLogPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    run,
    episodeLogPath
  };
}

async function createWallClipSetupRunFromSource(
  options: WallClipSetupOptions & { durationSeconds: number; seed: number; sourceRunPath: string }
): Promise<WallClipSetupResult> {
  const { romSha1, stateSha1 } = await loadInputHashes(options.romPath, options.statePath);
  const sourceRun = (await readJsonFile(options.sourceRunPath, "Source run")) as RunResult;
  const selected = selectBestWallClipSession(sourceRun);
  const session = cloneJson(selected);
  const episodeLogPath = options.episodeLogPath ?? defaultEpisodeLogPath(options.outPath);
  const episodeLogRunPath = formatEpisodeLogPathForRun(options.outPath, episodeLogPath);
  const overlaySamples = await readSourceOverlaySamples(options.sourceRunPath, sourceRun, session.agent?.episode);
  const frames = session.metrics.frames || session.replayInputs.at(-1)?.frameEnd || options.durationSeconds * 60;
  const existingAgent = session.agent;
  const score = Number(existingAgent?.score ?? session.metrics.maxProgress);
  const durationSeconds = Math.max(options.durationSeconds, Math.ceil(frames / 60));

  session.agent = {
    ...existingAgent,
    type: existingAgent?.type ?? "rl-go-explore-hybrid",
    episode: 1,
    episodeId: "episode_1",
    parentId: existingAgent?.episodeId ?? existingAgent?.parentId ?? "source-wallclip-run",
    score,
    newCells: existingAgent?.newCells ?? 0,
    cellsVisited: existingAgent?.cellsVisited ?? frames,
    uniqueCells: existingAgent?.uniqueCells ?? existingAgent?.newCells ?? 0,
    bugScore: Math.max(100, existingAgent?.bugScore ?? 0),
    progressScore: existingAgent?.progressScore ?? session.metrics.maxProgress,
    focus: "bugs",
    bugTarget: "wall-clip",
    mutation: existingAgent?.mutation ?? "extracted-wall-clip-repro"
  };

  const run: RunResult = {
    run: {
      id: createRunId([romSha1, stateSha1, "wallclip-source", options.sourceRunPath, String(session.metrics.frames), String(options.seed)]),
      game: "super-mario-bros-nes",
      objective: "world-4-2-known-glitches",
      durationSeconds,
      seed: options.seed,
      romSha1,
      stateSha1
    },
    discovery: {
      agentType: "rl-go-explore-hybrid",
      strategy: "go-explore",
      focus: "bugs",
      bugTarget: "wall-clip",
      episodes: 1,
      episodeDurationSeconds: durationSeconds,
      top: 1,
      seed: options.seed,
      workers: 1,
      uniqueCells: session.agent?.uniqueCells ?? session.agent?.newCells ?? 0,
      totalFindings: session.findings.length,
      bestScore: score,
      bestSavedScore: score,
      bestProgress: session.metrics.maxProgress,
      targetProgress: VINE_WARP_TARGET_PROGRESS,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      checkpointCount: 0,
      corpusSize: 1,
      episodeLog: {
        format: "jsonl",
        path: episodeLogRunPath,
        episodes: 1
      }
    },
    sessions: [session]
  };

  const record: EpisodeLogRecord = {
    episode: 1,
    session,
    overlaySamples
  };
  await mkdir(dirname(episodeLogPath), { recursive: true });
  await writeFile(episodeLogPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    run,
    episodeLogPath
  };
}

function createWallClipSetupFinding(samples: FrameSample[], replayInputs: ReproInputRange[]): Finding {
  const center = findWallClipSetupSample(samples) ?? samples[Math.max(0, Math.floor(samples.length * 0.55))] ?? samples.at(-1);
  const frameStart = Math.max(1, (center?.frame ?? 1) - 72);
  const frameEnd = Math.min(replayInputs.at(-1)?.frameEnd ?? center?.frame ?? frameStart, (center?.frame ?? frameStart) + 96);

  return {
    type: "wall-clip-risk",
    severity: "high",
    frameStart,
    frameEnd,
    summary: "Deterministic 4-2 wall-clip setup: sustained wall/pipe pressure with release, crouch, and jump timing.",
    evidence: {
      setup: "4-2-wall-clip",
      progress: center?.progress ?? 0,
      xOnScreen: center?.xOnScreen ?? 0,
      yOnScreen: center?.yOnScreen ?? 0,
      playerCollisionBits: center?.playerCollisionBits,
      playerHitDetectFlag: center?.playerHitDetectFlag,
      horizontalSpeedAbs: center?.horizontalSpeedAbs,
      scrollLock: center?.scrollLock,
      pipeInteraction: center?.pipeInteraction,
      pipeTileCount: center?.pipeTileCount,
      inputWindow: "right+B acceleration, wall pressure, left tap, down-right crouch pressure, jump-right retry"
    },
    reproInputs: sliceInputRanges(replayInputs, frameStart, frameEnd)
  };
}

function findWallClipSetupSample(samples: FrameSample[]): FrameSample | undefined {
  return samples.find((sample) => {
    const geometry =
      sample.pipeInteraction ||
      sample.pipeTileCount > 0 ||
      sample.scrollLock > 0 ||
      sample.playerCollisionBits !== 0xff ||
      sample.playerHitDetectFlag !== 0;
    return geometry && sample.progress >= 500 && !sample.dying;
  });
}

function scoreWallClipSetupSpeed(samples: FrameSample[], frame: number): number {
  const sample = samples.find((candidate) => candidate.frame >= frame);
  if (!sample) {
    return 0;
  }
  return Number(Math.max(0, 220 - frame / 12 + sample.progress / 12).toFixed(2));
}

function countRooms(samples: FrameSample[]): number {
  return new Set(samples.map((sample) => sample.roomId)).size;
}

function scoreDelta(samples: FrameSample[]): number {
  const first = samples[0]?.score ?? 0;
  const last = samples.at(-1)?.score ?? first;
  return Math.max(0, last - first);
}

async function loadInputs(romPath: string, statePath: string) {
  const romData = await readBinaryFile(romPath, "ROM");
  const stateText = await readTextFile(statePath, "Save state");
  let stateData: unknown;

  try {
    stateData = JSON.parse(stateText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Save state file is not valid JSON: ${message}`);
  }

  return {
    romData,
    stateData,
    romSha1: sha1(romData),
    stateSha1: sha1(stateText)
  };
}

async function loadInputHashes(romPath: string, statePath: string) {
  const romData = await readBinaryFile(romPath, "ROM");
  const stateText = await readTextFile(statePath, "Save state");
  JSON.parse(stateText);

  return {
    romData,
    stateText,
    romSha1: sha1(romData),
    stateSha1: sha1(stateText)
  };
}

function selectBestWallClipSession(run: RunResult) {
  const candidates = (run.sessions ?? []).filter((session) => session.findings.some((finding) => finding.type === "wall-clip-risk"));
  if (!candidates.length) {
    throw new Error("Source run does not contain any wall-clip-risk sessions.");
  }

  return candidates.sort((a, b) => {
    return (
      deathRank(a) - deathRank(b) ||
      severityScore(b) - severityScore(a) ||
      b.metrics.maxProgress - a.metrics.maxProgress ||
      (b.agent?.score ?? 0) - (a.agent?.score ?? 0) ||
      a.metrics.frames - b.metrics.frames
    );
  })[0]!;
}

function deathRank(session: { metrics: { deaths: number } }): number {
  return session.metrics.deaths > 0 ? 1 : 0;
}

function severityScore(session: { findings: Finding[] }): number {
  return session.findings.reduce((score, finding) => {
    if (finding.type !== "wall-clip-risk") {
      return score;
    }
    return score + (finding.severity === "high" ? 100 : finding.severity === "medium" ? 55 : finding.severity === "low" ? 20 : 5);
  }, 0);
}

async function readSourceOverlaySamples(sourceRunPath: string, sourceRun: RunResult, episode: number | undefined) {
  const sourceLogPath = sourceRun.discovery?.episodeLog?.path;
  if (!sourceLogPath || episode === undefined) {
    return [];
  }

  const resolvedLogPath = isAbsolute(sourceLogPath) ? sourceLogPath : resolve(dirname(resolve(sourceRunPath)), sourceLogPath);
  let text: string;
  try {
    text = await readTextFile(resolvedLogPath, "Source episode log");
  } catch {
    return [];
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line) as EpisodeLogRecord;
      if (record.episode === episode) {
        return Array.isArray(record.overlaySamples) ? record.overlaySamples : [];
      }
    } catch {
      continue;
    }
  }

  return [];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number, received ${value}.`);
  }
  return value;
}

function normalizeInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number, received ${value}.`);
  }
  return value;
}
