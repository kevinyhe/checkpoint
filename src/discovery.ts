import { Worker } from "node:worker_threads";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { HeadlessNes } from "./emulator.js";
import { executeEpisode, sessionFromExecution } from "./episode.js";
import { createRunId, readBinaryFile, readTextFile, sha1 } from "./files.js";
import { buttonsForFrame } from "./replay.js";
import { createSeededRandom } from "./rng.js";
import { decodeSmbRam } from "./smb-ram.js";
import type {
  BugTarget,
  ButtonName,
  DiscoveryFocus,
  DiscoverOptions,
  DiscoveryAgentMetadata,
  DiscoveryProgressEvent,
  DiscoveryStrategy,
  CoverageGoalSummary,
  EpisodeLogRecord,
  EpisodeLogSummary,
  Finding,
  FrameSample,
  OverlaySample,
  ReproInputRange,
  RunResult,
  SessionResult,
  SmbRamSnapshot
} from "./types.js";

export const MACRO_ACTIONS = [
  "idle",
  "right-b",
  "jump-right",
  "down-right",
  "left",
  "oscillate",
  "short-hop-left",
  "pipe-hold",
  "climb-right"
] as const;

export const DEFAULT_DISCOVERY_STRATEGY: DiscoveryStrategy = "rl-go-explore";
export const DEFAULT_CHECKPOINT_LIMIT = 160;
export const DEFAULT_DISCOVERY_FOCUS: DiscoveryFocus = "balanced";
export const DEFAULT_BUG_TARGET: BugTarget = "all";
export const VINE_WARP_TARGET_PROGRESS = 768;
export const BUG_PROBE_FRONTIER_PROGRESS = 560;
export const MAX_EFFECTIVE_CHECKPOINT_LIMIT = 160;
export const WORLD_4_2_COVERAGE_TARGET = "world-4-2-full" as const;
export const WORLD_4_2_REQUIRED_COVERAGE_GOALS = [
  "opening",
  "early-route",
  "mid-route",
  "vine-warp-approach",
  "post-target-frontier",
  "deep-frontier",
  "lower-route",
  "upper-block-route",
  "hidden-blocks",
  "hidden-vine",
  "warp-zone",
  "warp-pipe",
  "coin-room",
  "pipe-hotspot",
  "wall-clip-hotspot",
  "enemy-encounter",
  "moving-lifts",
  ...Array.from({ length: 16 }, (_, index) => `progress-${index.toString().padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `screen-${index.toString().padStart(2, "0")}`),
  "high-route"
] as const;
const ROUTE_SEED_CHECKPOINT_BUDGET = 96;
const EPISODE_CHECKPOINT_BUDGET = 40;
const SUB_AREA_OPENING_PROGRESS = 150;
const SUB_AREA_PULSE_ON_FRAMES = 22;
const SUB_AREA_PULSE_PERIOD_FRAMES = 26;
const SUB_AREA_ROUTE_HAZARD_PROGRESS = 1520;
const SUB_AREA_ROUTE_SAFE_FRONTIER_PROGRESS = 1640;
const SUB_AREA_FRONTIER_JUMP_ON_FRAMES = 18;
const SUB_AREA_FRONTIER_JUMP_PERIOD_FRAMES = 45;
const FULL_RUN_ROUTE_SEED_EPISODES = 6;
const FULL_RUN_FRESH_EXPLORATION_RATE = 0.04;
const RL_EXPLORE_FRACTION = 0.58;
const RL_CHECKPOINT_BUDGET = 64;
const RL_ACTION_MIN_FRAMES = 8;
const RL_ACTION_MAX_FRAMES = 42;

export type MacroActionName = (typeof MACRO_ACTIONS)[number];

export interface MacroStep {
  action: MacroActionName;
  frames: number;
}

export interface ProgressControllerConfig {
  jumpInterval: number;
  jumpDuration: number;
  jumpOffset: number;
  stuckFrames: number;
  recoveryFrames: number;
  pipeHoldFrames: number;
  exploratoryLeftEvery: number;
  exploratoryLeftFrames: number;
}

export interface ArchiveEntry {
  id: string;
  cell: string;
  stateData: unknown;
  replayInputs: ReproInputRange[];
  frame: number;
  progress: number;
  bestProgress: number;
  visits: number;
  attempts: number;
  deaths: number;
  successes: number;
  bestSurvivalFrames: number;
  bestChildProgress: number;
  novelty: number;
  bugScore: number;
  coverageGoals: string[];
  score: number;
  depth: number;
  targetReached: boolean;
  reason: string;
  controllerConfig: ProgressControllerConfig;
}

export interface ArchiveCheckpointInput {
  id: string;
  cell: string;
  stateData: unknown;
  replayInputs: ReproInputRange[];
  frame: number;
  progress: number;
  bestProgress: number;
  novelty: number;
  bugScore: number;
  coverageGoals: string[];
  depth: number;
  targetReached: boolean;
  reason: string;
  controllerConfig: ProgressControllerConfig;
}

interface DiscoveryEpisode {
  id: string;
  parentId?: string;
  trace?: MacroStep[];
  controllerConfig?: ProgressControllerConfig;
  session: SessionResult;
  cells: Set<string>;
  newCells: number;
  bugScore: number;
  progressScore: number;
  coverageScore: number;
  coverageGoalsHit: string[];
  routeScore: number;
  speedScore: number;
  roomScore: number;
  gameScore: number;
  gameScoreDelta: number;
  milestoneFrames: Record<string, number>;
  roomTransitions: number;
  roomsReached: string[];
  score: number;
  progressDelta: number;
  targetReached: boolean;
  obstacleWindow?: ForwardObstacleWindow;
  mutation: string;
  overlaySamples: OverlaySample[];
}

export interface ForwardObstacleWindow {
  frameStart: number;
  frameEnd: number;
  mutationFrame: number;
  progress: number;
  durationFrames: number;
  reason: string;
}

interface LoadedInputs {
  romData: Uint8Array;
  stateData: unknown;
  romSha1: string;
  stateSha1: string;
}

interface NormalizedDiscoveryOptions extends DiscoverOptions {
  episodes: number;
  episodeDurationSeconds: number;
  seed: number;
  top: number;
  workers: number;
  strategy: DiscoveryStrategy;
  focus: DiscoveryFocus;
  bugTarget: BugTarget;
  checkpointLimit: number;
  routeSeed: boolean;
  saveAll: boolean;
  episodeLogPath?: string;
}

interface DiscoveryShardOptions extends NormalizedDiscoveryOptions {
  workerIndex: number;
  episodeOffset: number;
}

interface DiscoveryShardResult {
  result: RunResult;
  cells: string[];
  corpusSize: number;
  checkpointCount: number;
  episodeLogRecords: number;
  episodeLogPath?: string;
  coverageGoals: string[];
}

interface DiscoveryWorkerMessage {
  type: "progress" | "result" | "error";
  event?: DiscoveryProgressEvent;
  shard?: DiscoveryShardResult;
  error?: string;
}

interface GoExploreEpisodeResult {
  episode: DiscoveryEpisode;
  checkpoints: ArchiveCheckpointInput[];
}

type GoExploreControlMode =
  | "route-seed"
  | "action-fuzz"
  | "warp-zone-probe"
  | "wall-clip-probe"
  | "wall-clip-trick"
  | "coverage-explore";

interface CapturedCheckpoint {
  checkpoint: ArchiveCheckpointInput;
  priority: number;
}

interface EpisodeLogWriteResult {
  path?: string;
  records: number;
}

const BUTTONS_BY_ACTION: Record<Exclude<MacroActionName, "oscillate">, ButtonName[]> = {
  idle: [],
  "right-b": ["B", "RIGHT"],
  "jump-right": ["A", "B", "RIGHT"],
  "down-right": ["DOWN", "RIGHT"],
  left: ["LEFT"],
  "short-hop-left": ["A", "LEFT"],
  "pipe-hold": ["B", "DOWN", "RIGHT"],
  "climb-right": ["UP", "RIGHT"]
};

export async function runDiscovery(options: DiscoverOptions): Promise<RunResult> {
  const normalized = normalizeDiscoveryOptions(options);
  const startedAt = Date.now();

  if (normalized.workers > 1) {
    const shards = await runDiscoveryWorkers(normalized);
    return mergeDiscoveryShards(shards, normalized);
  }

  const shard = await runDiscoveryShard({
    ...normalized,
    workerIndex: 0,
    episodeOffset: 0,
    onProgress: (event) => {
      options.onProgress?.({
        ...event,
        workers: normalized.workers,
        elapsedMs: Date.now() - startedAt
      });
    }
  });

  options.onProgress?.({
    type: "complete",
    episode: normalized.episodes,
    episodes: normalized.episodes,
    workerIndex: 0,
    workers: normalized.workers,
    bestScore: shard.result.discovery?.bestScore ?? 0,
    elapsedMs: Date.now() - startedAt
  });

  return shard.result;
}

export async function runDiscoveryShard(options: DiscoveryShardOptions): Promise<DiscoveryShardResult> {
  if (options.strategy === "rl-go-explore") {
    return runRlGoExploreDiscoveryShard(options);
  }
  if (options.strategy === "trace-mutation") {
    return runTraceMutationDiscoveryShard(options);
  }
  if (options.strategy === "full-run-evolution") {
    return runFullRunEvolutionDiscoveryShard(options);
  }

  return runGoExploreDiscoveryShard(options);
}

async function runGoExploreDiscoveryShard(options: DiscoveryShardOptions): Promise<DiscoveryShardResult> {
  const durationFrames = options.episodeDurationSeconds * 60;
  const inputs = await loadInputs(options.romPath, options.statePath);
  const random = createSeededRandom(options.seed);
  const globalCells = new Set<string>();
  const globalCoverageGoals = new Set<string>();
  const archive = new Map<string, ArchiveEntry>();
  const allEpisodes: DiscoveryEpisode[] = [];
  const startedAt = Date.now();
  const episodeLog = await initializeEpisodeLog(options);
  let checkpointSequence = 0;
  let bestProgress = 0;

  const initialController = createRouteSeedControllerConfig(options.seed);
  const initialEntry = createInitialArchiveEntry(inputs, initialController, options.workerIndex);
  upsertArchiveCheckpoint(archive, {
    ...initialEntry,
    id: initialEntry.id,
    novelty: 1
  }, options.checkpointLimit);
  globalCells.add(initialEntry.cell);
  bestProgress = Math.max(bestProgress, initialEntry.progress);

  if (options.routeSeed) {
    const routeSeed = executeGoExploreEpisode({
      id: `route_seed_w${options.workerIndex}`,
      globalEpisode: options.episodeOffset,
      parent: initialEntry,
      controllerConfig: initialController,
      mutation: "route-seed-controller",
      controlMode: "route-seed",
      durationFrames,
      inputs,
      globalCells,
      globalCoverageGoals,
      checkpointId: () => `cell_w${options.workerIndex}_${checkpointSequence += 1}`,
      focus: options.focus,
      bugTarget: options.bugTarget,
      checkpointBudget: Math.min(options.checkpointLimit, ROUTE_SEED_CHECKPOINT_BUDGET)
    });
    allEpisodes.push(routeSeed.episode);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, routeSeed.episode);
    bestProgress = Math.max(bestProgress, routeSeed.episode.session.metrics.maxProgress);
    for (const goal of routeSeed.episode.coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }
    for (const checkpoint of routeSeed.checkpoints) {
      checkpoint.novelty = globalCells.has(checkpoint.cell) ? 0 : 1;
      if (upsertArchiveCheckpoint(archive, checkpoint, options.checkpointLimit)) {
        globalCells.add(checkpoint.cell);
      }
    }
  }

  for (let episode = 1; episode <= options.episodes; episode += 1) {
    const coverageSummary = summarizeWorld42CoverageGoals(globalCoverageGoals);
    if (options.focus === "coverage" && coverageSummary.complete) {
      break;
    }

    const parent =
      chooseDiscoveryParent([...archive.values()], random, bestProgress, options.focus, options.bugTarget, coverageSummary) ?? initialEntry;
    parent.visits += 1;
    const controlMode = chooseGoExploreControlMode(parent, random, bestProgress, options.focus, options.bugTarget);
    const mutation =
      controlMode === "warp-zone-probe" || controlMode === "wall-clip-probe" || controlMode === "wall-clip-trick"
        ? { config: parent.controllerConfig, mutation: controlMode }
        : createProgressMutation(parent.controllerConfig, random, parent.progress, bestProgress);
    const globalEpisode = options.episodeOffset + episode;
    const id = `episode_${globalEpisode}`;
    const result = executeGoExploreEpisode({
      id,
      globalEpisode,
      parent,
      controllerConfig: mutation.config,
      mutation: formatMutationLabel(mutation.mutation, controlMode),
      controlMode,
      randomSeed: options.seed + globalEpisode * 7919,
      durationFrames,
      inputs,
      globalCells,
      globalCoverageGoals,
      checkpointId: () => `cell_w${options.workerIndex}_${checkpointSequence += 1}`,
      focus: options.focus,
      bugTarget: options.bugTarget,
      checkpointBudget: Math.min(options.checkpointLimit, EPISODE_CHECKPOINT_BUDGET)
    });
    updateArchiveParentOutcome(parent, result.episode.session);

    allEpisodes.push(result.episode);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, result.episode);
    bestProgress = Math.max(bestProgress, result.episode.session.metrics.maxProgress);
    for (const goal of result.episode.coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }

    for (const cell of result.episode.cells) {
      globalCells.add(cell);
    }

    for (const checkpoint of result.checkpoints) {
      checkpoint.novelty = globalCells.has(checkpoint.cell) ? 0 : 1;
      if (upsertArchiveCheckpoint(archive, checkpoint, options.checkpointLimit)) {
        globalCells.add(checkpoint.cell);
      }
    }

    options.onProgress?.({
      type: "episode",
      episode: globalEpisode,
      episodes: options.episodeOffset + options.episodes,
      workerIndex: options.workerIndex,
      workers: options.workers,
      score: result.episode.score,
      newCells: result.episode.newCells,
      findings: result.episode.session.findings.length,
      bestScore: Math.max(...allEpisodes.map((candidate) => candidate.score)),
      elapsedMs: Date.now() - startedAt
    });
  }

  const topEpisodes = selectTopEpisodes(allEpisodes, options.top, options.focus);

  return {
    result: createDiscoveryRunResult({
      inputs,
      options,
      agentType: "go-explore-checkpoint",
      globalCells,
      allEpisodes,
      topEpisodes,
      corpusSize: archive.size,
      checkpointCount: archive.size,
      episodeLogRecords: episodeLog.records,
      globalCoverageGoals
    }),
    cells: [...globalCells],
    corpusSize: archive.size,
    checkpointCount: archive.size,
    episodeLogRecords: episodeLog.records,
    episodeLogPath: episodeLog.path,
    coverageGoals: [...globalCoverageGoals]
  };
}

function executeGoExploreEpisode(options: {
  id: string;
  globalEpisode: number;
  parent: ArchiveEntry;
  controllerConfig: ProgressControllerConfig;
  mutation: string;
  controlMode?: GoExploreControlMode;
  randomSeed?: number;
  durationFrames: number;
  inputs: LoadedInputs;
  globalCells: Set<string>;
  globalCoverageGoals: Set<string>;
  checkpointId: () => string;
  focus: DiscoveryFocus;
  bugTarget: BugTarget;
  checkpointBudget: number;
}): GoExploreEpisodeResult {
  const random = createSeededRandom(options.randomSeed ?? options.globalEpisode);
  const controller = createGoExploreController(
    options.controlMode ?? "route-seed",
    random,
    options.controllerConfig,
    summarizeWorld42CoverageGoals(options.globalCoverageGoals).missing
  );
  const checkpoints: CapturedCheckpoint[] = [];
  const seenCheckpointKeys = new Set<string>();
  let previousSample: FrameSample | undefined;

  const execution = executeEpisode({
    romData: options.inputs.romData,
    stateData: options.parent.stateData,
    durationFrames: options.durationFrames,
    startFrame: options.parent.frame,
    prefixReplayInputs: options.parent.replayInputs,
    stopOnDeath: true,
    selectButtons: (frame, snapshot, durationFrames) => controller.buttons(frame, snapshot, durationFrames),
    onSample: (context) => {
      const reason = checkpointReason(context.sample, previousSample, options.parent.progress, seenCheckpointKeys);
      previousSample = context.sample;
      if (!reason) {
        return;
      }

      const cell = createArchiveCell(context.sample);
      const coverageGoals = [...classifyWorld42CoverageGoals(context.sample)];
      const priority = scoreCheckpointCaptureCandidate(context.sample, reason, options.parent.progress);
      const replaceIndex = checkpointReplacementIndex(checkpoints, priority, options.checkpointBudget);
      if (replaceIndex === undefined) {
        return;
      }

      const checkpoint: CapturedCheckpoint = {
        priority,
        checkpoint: {
        id: options.checkpointId(),
        cell,
        stateData: context.captureState(),
        replayInputs: context.replayInputs(),
        frame: context.globalFrame,
        progress: context.sample.progress,
        bestProgress: Math.max(options.parent.bestProgress, context.sample.progress),
        novelty: options.globalCells.has(cell) ? 0 : 1,
        bugScore: sampleBugPotential(context.sample),
        coverageGoals,
        depth: options.parent.depth + 1,
        targetReached: reachedVineWarpTarget(context.sample),
        reason,
        controllerConfig: options.controllerConfig
        }
      };

      if (replaceIndex === checkpoints.length) {
        checkpoints.push(checkpoint);
      } else {
        checkpoints[replaceIndex] = checkpoint;
      }
    }
  });

  const session = sessionFromExecution("coverage-explorer", execution);
  session.metrics.maxProgress = Math.max(session.metrics.maxProgress, options.parent.progress, options.parent.bestProgress);
  const cells = new Set(execution.samples.map(createArchiveCell));
  const newCells = countNewCells(cells, options.globalCells);
  const coverageGoalsHit = [...collectCoverageGoals(execution.samples)].sort();
  const coverageScore = scoreCoverageGoals(coverageGoalsHit, options.globalCoverageGoals);
  const milestoneFrames = computeMilestoneFrames(execution.samples);
  const speedScore = scoreSpeedMilestones(milestoneFrames, session.metrics.deaths);
  const roomStats = computeRoomStats(execution.samples);
  const roomScore = scoreRooms(roomStats);
  const gameScoreStats = computeGameScoreStats(execution.samples);
  const gameScore = scoreGameScoreDelta(gameScoreStats.delta);
  const bugScore = scoreFindings(session.findings);
  const targetReached = session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS || session.coverage.includes("hidden-vine") || session.coverage.includes("warp-zone");
  const progressScore = scoreDiscoveryProgress(session, cells, newCells, {
    startProgress: options.parent.progress,
    targetReached,
    coverageScore,
    speedScore,
    roomScore,
    gameScore
  });
  const progressDelta = Math.max(0, session.metrics.maxProgress - options.parent.progress);
  const score = scoreDiscoveryEpisode(session, cells, newCells, bugScore, {
    startProgress: options.parent.progress,
    targetReached,
    coverageScore
  });
  const deathFrame = execution.samples.find((sample) => sample.dying)?.frame;
  const overlaySamples = createOverlaySamples(execution.samples, session.findings);
  const metadata: DiscoveryAgentMetadata = {
    type: "go-explore-checkpoint",
    episode: options.globalEpisode,
    episodeId: options.id,
    parentId: options.parent.id,
    startCell: options.parent.cell,
    startFrame: options.parent.frame,
    prefixFrames: options.parent.frame,
    suffixFrames: execution.samples.length,
    score,
    newCells,
    cellsVisited: execution.samples.length,
    uniqueCells: cells.size,
    bugScore,
    progressScore,
    coverageScore,
    coverageGoalsHit,
    routeScore: 0,
    speedScore,
    roomScore,
    gameScore,
    gameScoreDelta: gameScoreStats.delta,
    milestoneFrames,
    roomTransitions: roomStats.transitions,
    roomsReached: roomStats.rooms,
    progressDelta,
    targetReached,
    focus: options.focus,
    bugTarget: options.bugTarget,
    mutation: options.mutation
  };

  session.agent = metadata;

  return {
    episode: {
      id: options.id,
      parentId: options.parent.id,
      controllerConfig: options.controllerConfig,
      session,
      cells,
      newCells,
      bugScore,
      progressScore,
      coverageScore,
      coverageGoalsHit,
      routeScore: 0,
      speedScore,
      roomScore,
      gameScore,
      gameScoreDelta: gameScoreStats.delta,
      milestoneFrames,
      roomTransitions: roomStats.transitions,
      roomsReached: roomStats.rooms,
      score,
      progressDelta,
      targetReached,
      mutation: options.mutation,
      overlaySamples
    },
    checkpoints: checkpoints
      .map((candidate) => candidate.checkpoint)
      .filter((checkpoint) => shouldKeepCheckpointAfterEpisode(checkpoint, deathFrame))
      .map((checkpoint) => ({
        ...checkpoint,
        bugScore: Math.max(checkpoint.bugScore, bugScore > 0 && checkpoint.progress >= options.parent.progress ? Math.min(25, bugScore) : 0)
      }))
  };
}

async function runTraceMutationDiscoveryShard(options: DiscoveryShardOptions): Promise<DiscoveryShardResult> {
  const durationFrames = options.episodeDurationSeconds * 60;
  const inputs = await loadInputs(options.romPath, options.statePath);
  const random = createSeededRandom(options.seed);
  const globalCells = new Set<string>();
  const globalCoverageGoals = new Set<string>();
  const corpus: DiscoveryEpisode[] = [];
  const allEpisodes: DiscoveryEpisode[] = [];
  const startedAt = Date.now();
  const episodeLog = await initializeEpisodeLog(options);

  for (let episode = 1; episode <= options.episodes; episode += 1) {
    if (options.focus === "coverage" && summarizeWorld42CoverageGoals(globalCoverageGoals).complete) {
      break;
    }

    const parent = chooseParent(corpus, random);
    const mutation = parent?.trace
      ? mutateMacroTrace(parent.trace, random, durationFrames)
      : {
          trace: generateFreshMacroTrace(random, durationFrames),
          mutation: "fresh"
        };

    const replayInputs = expandMacroTrace(mutation.trace, durationFrames);
    const execution = executeEpisode({
      romData: inputs.romData,
      stateData: inputs.stateData,
      durationFrames,
      stopOnDeath: true,
      selectButtons: (frame, snapshot) => {
        const reactive = reactiveDiscoveryButtons(snapshot);
        return reactive ?? buttonsForFrame(replayInputs, frame);
      }
    });
    const session = sessionFromExecution("coverage-explorer", execution);
    const overlaySamples = createOverlaySamples(execution.samples, session.findings);
    const cells = new Set(execution.samples.map(createArchiveCell));
    const newCells = countNewCells(cells, globalCells);
    const coverageGoalsHit = [...collectCoverageGoals(execution.samples)].sort();
    const coverageScore = scoreCoverageGoals(coverageGoalsHit, globalCoverageGoals);
    const milestoneFrames = computeMilestoneFrames(execution.samples);
    const speedScore = scoreSpeedMilestones(milestoneFrames, session.metrics.deaths);
    const roomStats = computeRoomStats(execution.samples);
    const roomScore = scoreRooms(roomStats);
    const gameScoreStats = computeGameScoreStats(execution.samples);
    const gameScore = scoreGameScoreDelta(gameScoreStats.delta);
    const bugScore = scoreFindings(session.findings);
    const progressScore = scoreDiscoveryProgress(session, cells, newCells);
    const score = scoreDiscoveryEpisode(session, cells, newCells, bugScore, { coverageScore, speedScore, roomScore, gameScore });
    const globalEpisode = options.episodeOffset + episode;
    const id = `episode_${globalEpisode}`;
    const metadata: DiscoveryAgentMetadata = {
      type: "coverage-guided-explorer",
      episode: globalEpisode,
      episodeId: id,
      parentId: parent?.id,
      score,
      newCells,
      cellsVisited: execution.samples.length,
      uniqueCells: cells.size,
      bugScore,
      progressScore,
      coverageScore,
      coverageGoalsHit,
      routeScore: 0,
      speedScore,
      roomScore,
      gameScore,
      gameScoreDelta: gameScoreStats.delta,
      milestoneFrames,
      roomTransitions: roomStats.transitions,
      roomsReached: roomStats.rooms,
      progressDelta: session.metrics.maxProgress,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      focus: options.focus,
      bugTarget: options.bugTarget,
      mutation: mutation.mutation
    };

    session.agent = metadata;
    const result: DiscoveryEpisode = {
      id,
      parentId: parent?.id,
      trace: mutation.trace,
      session,
      cells,
      newCells,
      bugScore,
      progressScore,
      coverageScore,
      coverageGoalsHit,
      routeScore: 0,
      speedScore,
      roomScore,
      gameScore,
      gameScoreDelta: gameScoreStats.delta,
      milestoneFrames,
      roomTransitions: roomStats.transitions,
      roomsReached: roomStats.rooms,
      score,
      progressDelta: session.metrics.maxProgress,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      mutation: mutation.mutation,
      overlaySamples
    };

    for (const cell of cells) {
      globalCells.add(cell);
    }
    for (const goal of coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }
    allEpisodes.push(result);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, result);

    if (shouldKeepInCorpus(result)) {
      corpus.push(result);
      corpus.sort((a, b) => b.score - a.score);
      corpus.splice(50);
    }

    options.onProgress?.({
      type: "episode",
      episode: globalEpisode,
      episodes: options.episodeOffset + options.episodes,
      workerIndex: options.workerIndex,
      workers: options.workers,
      score,
      newCells,
      findings: session.findings.length,
      bestScore: Math.max(...allEpisodes.map((candidate) => candidate.score)),
      elapsedMs: Date.now() - startedAt
    });
  }

  const topEpisodes = selectTopEpisodes(allEpisodes, options.top, options.focus);

  return {
    result: createDiscoveryRunResult({
      inputs,
      options,
      agentType: "coverage-guided-explorer",
      globalCells,
      allEpisodes,
      topEpisodes,
      corpusSize: corpus.length,
      checkpointCount: 0,
      episodeLogRecords: episodeLog.records,
      globalCoverageGoals
    }),
    cells: [...globalCells],
    corpusSize: corpus.length,
    checkpointCount: 0,
    episodeLogRecords: episodeLog.records,
    episodeLogPath: episodeLog.path,
    coverageGoals: [...globalCoverageGoals]
  };
}

async function runFullRunEvolutionDiscoveryShard(options: DiscoveryShardOptions): Promise<DiscoveryShardResult> {
  const durationFrames = options.episodeDurationSeconds * 60;
  const inputs = await loadInputs(options.romPath, options.statePath);
  const random = createSeededRandom(options.seed);
  const globalCells = new Set<string>();
  const globalCoverageGoals = new Set<string>();
  const corpus: DiscoveryEpisode[] = [];
  const allEpisodes: DiscoveryEpisode[] = [];
  const startedAt = Date.now();
  const episodeLog = await initializeEpisodeLog(options);
  const routeSeedEpisodeCount = options.routeSeed
    ? Math.min(FULL_RUN_ROUTE_SEED_EPISODES, Math.max(1, Math.ceil(options.episodes * 0.18)))
    : 0;

  for (let episode = 1; episode <= options.episodes; episode += 1) {
    if (options.focus === "coverage" && summarizeWorld42CoverageGoals(globalCoverageGoals).complete) {
      break;
    }

    const shouldRunRouteSeed = episode <= routeSeedEpisodeCount;
    const parent = shouldRunRouteSeed ? undefined : chooseFullRunEvolutionParent(corpus, random);
    const allowExploration =
      options.focus === "coverage" ||
      options.focus === "bugs" ||
      Boolean(parent?.targetReached) ||
      Boolean(parent && parent.session.metrics.deaths === 0 && parent.session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS);
    const mutation = shouldRunRouteSeed
      ? {
          trace: generateForwardRouteTrace(createSeededRandom(options.seed + episode * 101), durationFrames),
          mutation: "route-first-seed"
        }
      : parent?.trace
        ? mutateFullRunTrace(parent.trace, parent.session, random, durationFrames, { allowExploration })
        : generateFreshFullRunTrace(random, durationFrames, options.focus);

    const plannedReplayInputs = expandMacroTrace(mutation.trace, durationFrames);
    const routeSeedController = shouldRunRouteSeed
      ? new ProgressController(progressBiasedConfig(createRouteSeedControllerConfig(options.seed + episode * 29)))
      : undefined;
    const execution = executeEpisode({
      romData: inputs.romData,
      stateData: inputs.stateData,
      durationFrames,
      stopOnDeath: true,
      selectButtons: (frame, snapshot) => {
        if (routeSeedController) {
          return routeSeedController.buttons(frame, snapshot, durationFrames);
        }
        const reactive = reactiveDiscoveryButtons(snapshot);
        return reactive ?? buttonsForFrame(plannedReplayInputs, frame);
      }
    });
    const session = sessionFromExecution("coverage-explorer", execution);
    const actualTrace = macroTraceFromReplayInputs(execution.replayInputs);
    const obstacleWindow = detectForwardObstacleWindow(execution.samples, execution.replayInputs);
    const overlaySamples = createOverlaySamples(execution.samples, session.findings);
    const cells = new Set(execution.samples.map(createArchiveCell));
    const newCells = countNewCells(cells, globalCells);
    const coverageGoalsHit = [...collectCoverageGoals(execution.samples)].sort();
    const coverageScore = scoreCoverageGoals(coverageGoalsHit, globalCoverageGoals);
    const bugScore = scoreFindings(session.findings);
    const milestoneFrames = computeMilestoneFrames(execution.samples);
    const speedScore = scoreSpeedMilestones(milestoneFrames, session.metrics.deaths);
    const routeScore = scoreRouteEfficiency(execution.samples, session.metrics.deaths);
    const roomStats = computeRoomStats(execution.samples);
    const roomScore = scoreRooms(roomStats);
    const gameScoreStats = computeGameScoreStats(execution.samples);
    const gameScore = scoreGameScoreDelta(gameScoreStats.delta);
    const progressScore = scoreDiscoveryProgress(session, cells, newCells, {
      coverageScore
    });
    const score = scoreDiscoveryEpisode(session, cells, newCells, bugScore, {
      coverageScore,
      routeScore,
      speedScore,
      roomScore,
      gameScore
    });
    const globalEpisode = options.episodeOffset + episode;
    const id = `episode_${globalEpisode}`;
    const metadata: DiscoveryAgentMetadata = {
      type: "full-run-evolution",
      episode: globalEpisode,
      episodeId: id,
      parentId: parent?.id,
      startFrame: 0,
      prefixFrames: 0,
      suffixFrames: execution.samples.length,
      score,
      newCells,
      cellsVisited: execution.samples.length,
      uniqueCells: cells.size,
      bugScore,
      progressScore,
      coverageScore,
      coverageGoalsHit,
      routeScore,
      speedScore,
      roomScore,
      gameScore,
      gameScoreDelta: gameScoreStats.delta,
      milestoneFrames,
      roomTransitions: roomStats.transitions,
      roomsReached: roomStats.rooms,
      progressDelta: session.metrics.maxProgress,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      obstacleFrame: obstacleWindow?.mutationFrame,
      obstacleProgress: obstacleWindow?.progress,
      obstacleDurationFrames: obstacleWindow?.durationFrames,
      obstacleReason: obstacleWindow?.reason,
      focus: options.focus,
      bugTarget: options.bugTarget,
      mutation: mutation.mutation
    };

    session.agent = metadata;
    const result: DiscoveryEpisode = {
      id,
      parentId: parent?.id,
      trace: actualTrace.length ? actualTrace : mutation.trace,
      session,
      cells,
      newCells,
      bugScore,
      progressScore,
      coverageScore,
      coverageGoalsHit,
      routeScore,
      speedScore,
      roomScore,
      gameScore,
      gameScoreDelta: gameScoreStats.delta,
      milestoneFrames,
      roomTransitions: roomStats.transitions,
      roomsReached: roomStats.rooms,
      score,
      progressDelta: session.metrics.maxProgress,
      targetReached: session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS,
      obstacleWindow,
      mutation: mutation.mutation,
      overlaySamples
    };

    for (const cell of cells) {
      globalCells.add(cell);
    }
    for (const goal of coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }
    allEpisodes.push(result);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, result);

    if (shouldKeepFullRunInCorpus(result)) {
      corpus.push(result);
      pruneFullRunCorpus(corpus);
    }

    options.onProgress?.({
      type: "episode",
      episode: globalEpisode,
      episodes: options.episodeOffset + options.episodes,
      workerIndex: options.workerIndex,
      workers: options.workers,
      score,
      newCells,
      findings: session.findings.length,
      bestScore: Math.max(...allEpisodes.map((candidate) => candidate.score)),
      elapsedMs: Date.now() - startedAt
    });
  }

  const topEpisodes = selectTopEpisodes(allEpisodes, options.top, options.focus);

  return {
    result: createDiscoveryRunResult({
      inputs,
      options,
      agentType: "full-run-evolution",
      globalCells,
      allEpisodes,
      topEpisodes,
      corpusSize: corpus.length,
      checkpointCount: 0,
      episodeLogRecords: episodeLog.records,
      globalCoverageGoals
    }),
    cells: [...globalCells],
    corpusSize: corpus.length,
    checkpointCount: 0,
    episodeLogRecords: episodeLog.records,
    episodeLogPath: episodeLog.path,
    coverageGoals: [...globalCoverageGoals]
  };
}

async function runRlGoExploreDiscoveryShard(options: DiscoveryShardOptions): Promise<DiscoveryShardResult> {
  const durationFrames = options.episodeDurationSeconds * 60;
  const inputs = await loadInputs(options.romPath, options.statePath);
  const random = createSeededRandom(options.seed);
  const globalCells = new Set<string>();
  const globalCoverageGoals = new Set<string>();
  const archive = new Map<string, ArchiveEntry>();
  const allEpisodes: DiscoveryEpisode[] = [];
  const rlPolicy = new TabularRlPolicy();
  const startedAt = Date.now();
  const episodeLog = await initializeEpisodeLog(options);
  const rlEpisodeCount = Math.max(1, Math.min(options.episodes, Math.ceil(options.episodes * RL_EXPLORE_FRACTION)));
  let checkpointSequence = 0;
  let bestProgress = 0;

  const initialController = progressBiasedConfig(createRouteSeedControllerConfig(options.seed));
  const initialEntry = createInitialArchiveEntry(inputs, initialController, options.workerIndex);
  upsertArchiveCheckpoint(archive, { ...initialEntry, novelty: 1 }, options.checkpointLimit);
  globalCells.add(initialEntry.cell);

  for (let episode = 1; episode <= rlEpisodeCount; episode += 1) {
    if (options.focus === "coverage" && summarizeWorld42CoverageGoals(globalCoverageGoals).complete) {
      break;
    }

    const globalEpisode = options.episodeOffset + episode;
    const epsilon = rlExplorationRate(episode, rlEpisodeCount, options.focus);
    const controller = new RlExplorationController(
      rlPolicy,
      createSeededRandom(options.seed + globalEpisode * 3571),
      epsilon,
      options.focus
    );
    const checkpoints: CapturedCheckpoint[] = [];
    const seenCheckpointKeys = new Set<string>();
    let previousSample: FrameSample | undefined;

    const execution = executeEpisode({
      romData: inputs.romData,
      stateData: inputs.stateData,
      durationFrames,
      stopOnDeath: true,
      selectButtons: (frame, snapshot) => controller.buttons(frame, snapshot, durationFrames),
      onSample: (context) => {
        const reason = checkpointReason(context.sample, previousSample, 0, seenCheckpointKeys);
        previousSample = context.sample;
        if (!reason) {
          return;
        }

        const cell = createArchiveCell(context.sample);
        const priority = scoreCheckpointCaptureCandidate(context.sample, reason, 0) + Math.min(80, sampleBugPotential(context.sample) * 2);
        const replaceIndex = checkpointReplacementIndex(checkpoints, priority, Math.min(options.checkpointLimit, RL_CHECKPOINT_BUDGET));
        if (replaceIndex === undefined) {
          return;
        }

        const checkpoint: CapturedCheckpoint = {
          priority,
          checkpoint: {
            id: `rl_cell_w${options.workerIndex}_${checkpointSequence += 1}`,
            cell,
            stateData: context.captureState(),
            replayInputs: context.replayInputs(),
            frame: context.globalFrame,
            progress: context.sample.progress,
            bestProgress: Math.max(bestProgress, context.sample.progress),
            novelty: globalCells.has(cell) ? 0 : 1,
            bugScore: sampleBugPotential(context.sample),
            coverageGoals: [...classifyWorld42CoverageGoals(context.sample)],
            depth: 1,
            targetReached: reachedVineWarpTarget(context.sample),
            reason: `rl-${reason}`,
            controllerConfig: initialController
          }
        };

        if (replaceIndex === checkpoints.length) {
          checkpoints.push(checkpoint);
        } else {
          checkpoints[replaceIndex] = checkpoint;
        }
      }
    });
    controller.finish(execution.samples.at(-1));

    const id = `episode_${globalEpisode}`;
    const result = createRlDiscoveryEpisode({
      id,
      globalEpisode,
      phase: "rl-explore",
      mutation: `rl-explore-epsilon-${epsilon.toFixed(2)}`,
      parentId: undefined,
      execution,
      globalCells,
      globalCoverageGoals,
      focus: options.focus,
      bugTarget: options.bugTarget,
      rlEpsilon: epsilon,
      rlStateCount: rlPolicy.stateCount,
      rlUpdateCount: rlPolicy.updateCount
    });

    allEpisodes.push(result);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, result);
    bestProgress = Math.max(bestProgress, result.session.metrics.maxProgress);
    for (const cell of result.cells) {
      globalCells.add(cell);
    }
    for (const goal of result.coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }
    for (const candidate of checkpoints) {
      candidate.checkpoint.bestProgress = Math.max(candidate.checkpoint.bestProgress, bestProgress);
      if (upsertArchiveCheckpoint(archive, candidate.checkpoint, options.checkpointLimit)) {
        globalCells.add(candidate.checkpoint.cell);
      }
    }

    options.onProgress?.({
      type: "episode",
      episode: globalEpisode,
      episodes: options.episodeOffset + options.episodes,
      workerIndex: options.workerIndex,
      workers: options.workers,
      score: result.score,
      newCells: result.newCells,
      findings: result.session.findings.length,
      bestScore: Math.max(...allEpisodes.map((candidate) => candidate.score)),
      elapsedMs: Date.now() - startedAt
    });
  }

  for (let localEpisode = rlEpisodeCount + 1; localEpisode <= options.episodes; localEpisode += 1) {
    const globalEpisode = options.episodeOffset + localEpisode;
    const coverageSummary = summarizeWorld42CoverageGoals(globalCoverageGoals);
    const bugFocus: DiscoveryFocus = options.focus === "progress" ? "balanced" : "bugs";
    const parent =
      chooseDiscoveryParent([...archive.values()], random, bestProgress, bugFocus, options.bugTarget, coverageSummary) ?? initialEntry;
    parent.visits += 1;
    const controlMode = chooseGoExploreControlMode(parent, random, bestProgress, bugFocus, options.bugTarget);
    const mutation =
      controlMode === "warp-zone-probe" || controlMode === "wall-clip-probe" || controlMode === "wall-clip-trick"
        ? { config: parent.controllerConfig, mutation: controlMode }
        : createProgressMutation(parent.controllerConfig, random, parent.progress, bestProgress);
    const result = executeGoExploreEpisode({
      id: `episode_${globalEpisode}`,
      globalEpisode,
      parent,
      controllerConfig: mutation.config,
      mutation: `rl-handoff-${formatMutationLabel(mutation.mutation, controlMode)}`,
      controlMode,
      randomSeed: options.seed + globalEpisode * 7919,
      durationFrames,
      inputs,
      globalCells,
      globalCoverageGoals,
      checkpointId: () => `rl_bug_cell_w${options.workerIndex}_${checkpointSequence += 1}`,
      focus: options.focus,
      bugTarget: options.bugTarget,
      checkpointBudget: Math.min(options.checkpointLimit, EPISODE_CHECKPOINT_BUDGET)
    });
    result.episode.session.agent = {
      ...result.episode.session.agent!,
      type: "rl-go-explore-hybrid",
      phase: "go-explore-bug"
    };

    allEpisodes.push(result.episode);
    episodeLog.records += await appendDiscoveryEpisodeLog(episodeLog.path, result.episode);
    updateArchiveParentOutcome(parent, result.episode.session);
    bestProgress = Math.max(bestProgress, result.episode.session.metrics.maxProgress);
    for (const goal of result.episode.coverageGoalsHit) {
      globalCoverageGoals.add(goal);
    }
    for (const checkpoint of result.checkpoints) {
      checkpoint.novelty = globalCells.has(checkpoint.cell) ? 0 : 1;
      if (upsertArchiveCheckpoint(archive, checkpoint, options.checkpointLimit)) {
        globalCells.add(checkpoint.cell);
      }
    }

    options.onProgress?.({
      type: "episode",
      episode: globalEpisode,
      episodes: options.episodeOffset + options.episodes,
      workerIndex: options.workerIndex,
      workers: options.workers,
      score: result.episode.score,
      newCells: result.episode.newCells,
      findings: result.episode.session.findings.length,
      bestScore: Math.max(...allEpisodes.map((candidate) => candidate.score)),
      elapsedMs: Date.now() - startedAt
    });
  }

  const topEpisodes = selectTopEpisodes(allEpisodes, options.top, options.focus);

  return {
    result: createDiscoveryRunResult({
      inputs,
      options,
      agentType: "rl-go-explore-hybrid",
      globalCells,
      allEpisodes,
      topEpisodes,
      corpusSize: rlPolicy.stateCount,
      checkpointCount: archive.size,
      episodeLogRecords: episodeLog.records,
      globalCoverageGoals
    }),
    cells: [...globalCells],
    corpusSize: rlPolicy.stateCount,
    checkpointCount: archive.size,
    episodeLogRecords: episodeLog.records,
    episodeLogPath: episodeLog.path,
    coverageGoals: [...globalCoverageGoals]
  };
}

async function runDiscoveryWorkers(options: NormalizedDiscoveryOptions): Promise<DiscoveryShardResult[]> {
  const startedAt = Date.now();
  const episodeCounts = distributeEpisodes(options.episodes, options.workers);
  const shardEpisodeLogPaths = options.saveAll && options.episodeLogPath
    ? episodeCounts.map((_, workerIndex) => createShardEpisodeLogPath(options.episodeLogPath!, workerIndex))
    : [];
  let episodeOffset = 0;
  const workers = episodeCounts.map((episodesForWorker, workerIndex) => {
    const shardOptions: DiscoveryShardOptions = {
      romPath: options.romPath,
      statePath: options.statePath,
      outPath: options.outPath,
      episodes: episodesForWorker,
      episodeDurationSeconds: options.episodeDurationSeconds,
      seed: options.seed + workerIndex * 1000003,
      top: options.top,
      workers: options.workers,
      progress: options.progress,
      strategy: options.strategy,
      focus: options.focus,
      bugTarget: options.bugTarget,
      checkpointLimit: options.checkpointLimit,
      routeSeed: options.routeSeed,
      saveAll: options.saveAll,
      episodeLogPath: shardEpisodeLogPaths[workerIndex],
      workerIndex,
      episodeOffset
    };
    episodeOffset += episodesForWorker;

    return runDiscoveryWorker(shardOptions, (event) => {
      options.onProgress?.({
        ...event,
        episodes: options.episodes,
        workers: options.workers,
        elapsedMs: Date.now() - startedAt
      });
    });
  });

  const shards = await Promise.all(workers);
  if (options.saveAll && options.episodeLogPath) {
    await mergeEpisodeLogFiles(
      shardEpisodeLogPaths.filter((path) => path !== undefined),
      options.episodeLogPath
    );
  }
  options.onProgress?.({
    type: "complete",
    episode: options.episodes,
    episodes: options.episodes,
    workerIndex: -1,
    workers: options.workers,
    bestScore: Math.max(0, ...shards.map((shard) => shard.result.discovery?.bestScore ?? 0)),
    elapsedMs: Date.now() - startedAt
  });

  return shards;
}

function runDiscoveryWorker(
  options: DiscoveryShardOptions,
  onProgress: (event: DiscoveryProgressEvent) => void
): Promise<DiscoveryShardResult> {
  if (import.meta.url.endsWith(".ts")) {
    return runDiscoveryShard({
      ...options,
      onProgress
    });
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(getDiscoveryWorkerUrl(), {
      workerData: options,
      execArgv: getDiscoveryWorkerExecArgv()
    });

    worker.on("message", (message: DiscoveryWorkerMessage) => {
      if (message.type === "progress" && message.event) {
        onProgress(message.event);
      } else if (message.type === "result" && message.shard) {
        resolve(message.shard);
      } else if (message.type === "error") {
        reject(new Error(message.error ?? "Discovery worker failed."));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Discovery worker exited with code ${code}.`));
      }
    });
  });
}

function mergeDiscoveryShards(shards: DiscoveryShardResult[], options: NormalizedDiscoveryOptions): RunResult {
  const sessions = shards.flatMap((shard) => shard.result.sessions);
  const topSessions = selectSavedDiscoverySessions(sessions, options.top, options.focus);
  const firstRun = shards[0]?.result.run;
  const cells = new Set(shards.flatMap((shard) => shard.cells));
  const coverageGoals = new Set(shards.flatMap((shard) => shard.coverageGoals));
  const coverageGoal = summarizeWorld42CoverageGoals(coverageGoals);

  if (!firstRun) {
    throw new Error("Discovery produced no shard results.");
  }

  return {
    run: {
      ...firstRun,
      id: createRunId([
        firstRun.romSha1,
        firstRun.stateSha1,
        "discover",
        options.strategy,
        options.focus,
        options.bugTarget,
        String(options.episodes),
        String(options.episodeDurationSeconds),
        String(options.seed),
        String(options.workers)
      ]),
      durationSeconds: options.episodeDurationSeconds,
      seed: options.seed
    },
    discovery: {
      agentType:
        options.strategy === "rl-go-explore"
          ? "rl-go-explore-hybrid"
          : options.strategy === "go-explore"
          ? "go-explore-checkpoint"
          : options.strategy === "full-run-evolution"
            ? "full-run-evolution"
            : "coverage-guided-explorer",
      strategy: options.strategy,
      focus: options.focus,
      bugTarget: options.bugTarget,
      episodes: options.episodes,
      episodeDurationSeconds: options.episodeDurationSeconds,
      top: options.top,
      seed: options.seed,
      workers: options.workers,
      uniqueCells: cells.size,
      totalFindings: shards.reduce((total, shard) => total + (shard.result.discovery?.totalFindings ?? 0), 0),
      bestScore: Math.max(0, ...shards.map((shard) => shard.result.discovery?.bestScore ?? 0)),
      bestSavedScore: Math.max(0, ...topSessions.map((session) => session.agent?.score ?? 0)),
      bestProgress: Math.max(0, ...shards.map((shard) => shard.result.discovery?.bestProgress ?? 0)),
      bestCoveragePercent: Math.max(0, ...shards.map((shard) => shard.result.discovery?.bestCoveragePercent ?? 0), coverageGoal.percent),
      targetProgress: VINE_WARP_TARGET_PROGRESS,
      targetReached: shards.some((shard) => shard.result.discovery?.targetReached),
      checkpointCount: shards.reduce((total, shard) => total + shard.checkpointCount, 0),
      corpusSize: shards.reduce((total, shard) => total + shard.corpusSize, 0),
      coverageGoal,
      episodeLog: createEpisodeLogSummary(
        options.outPath,
        options.episodeLogPath,
        shards.reduce((total, shard) => total + shard.episodeLogRecords, 0)
      )
    },
    sessions: topSessions
  };
}

function createDiscoveryRunResult(options: {
  inputs: LoadedInputs;
  options: DiscoveryShardOptions;
  agentType: "coverage-guided-explorer" | "go-explore-checkpoint" | "full-run-evolution" | "rl-go-explore-hybrid";
  globalCells: Set<string>;
  globalCoverageGoals: Set<string>;
  allEpisodes: DiscoveryEpisode[];
  topEpisodes: DiscoveryEpisode[];
  corpusSize: number;
  checkpointCount: number;
  episodeLogRecords: number;
}): RunResult {
  const bestProgress = Math.max(0, ...options.allEpisodes.map((episode) => episode.session.metrics.maxProgress));
  const coverageGoal = summarizeWorld42CoverageGoals(options.globalCoverageGoals);
  const bestCoveragePercent = Math.max(
    0,
    ...options.allEpisodes.map((episode) => summarizeWorld42CoverageGoals(episode.coverageGoalsHit).percent),
    coverageGoal.percent
  );

  return {
    run: {
      id: createRunId([
        options.inputs.romSha1,
        options.inputs.stateSha1,
      "discover",
      options.options.strategy,
      options.options.focus,
      options.options.bugTarget,
      String(options.options.episodes),
        String(options.options.episodeDurationSeconds),
        String(options.options.seed)
      ]),
      game: "super-mario-bros-nes",
      objective: "world-4-2-known-glitches",
      durationSeconds: options.options.episodeDurationSeconds,
      seed: options.options.seed,
      romSha1: options.inputs.romSha1,
      stateSha1: options.inputs.stateSha1
    },
    discovery: {
      agentType: options.agentType,
      strategy: options.options.strategy,
      focus: options.options.focus,
      bugTarget: options.options.bugTarget,
      episodes: options.options.episodes,
      episodeDurationSeconds: options.options.episodeDurationSeconds,
      top: options.options.top,
      seed: options.options.seed,
      workers: options.options.workers,
      uniqueCells: options.globalCells.size,
      totalFindings: options.allEpisodes.reduce((total, episode) => total + episode.session.findings.length, 0),
      bestScore: Math.max(0, ...options.allEpisodes.map((episode) => episode.score)),
      bestSavedScore: Math.max(0, ...options.topEpisodes.map((episode) => episode.score)),
      bestProgress,
      bestCoveragePercent,
      targetProgress: VINE_WARP_TARGET_PROGRESS,
      targetReached: options.allEpisodes.some((episode) => episode.targetReached),
      checkpointCount: options.checkpointCount,
      corpusSize: options.corpusSize,
      coverageGoal,
      episodeLog: createEpisodeLogSummary(options.options.outPath, options.options.episodeLogPath, options.episodeLogRecords)
    },
    sessions: options.topEpisodes.map((episode) => episode.session)
  };
}

export function defaultEpisodeLogPath(outPath: string): string {
  const parsed = parse(outPath);
  return join(parsed.dir, `${parsed.name}.episodes.jsonl`);
}

export function resolveEpisodeLogPath(outPath?: string, episodeLogPath?: string): string | undefined {
  if (episodeLogPath) {
    return episodeLogPath;
  }

  return outPath ? defaultEpisodeLogPath(outPath) : undefined;
}

function createEpisodeLogSummary(outPath: string | undefined, episodeLogPath: string | undefined, records: number): EpisodeLogSummary | undefined {
  if (!episodeLogPath) {
    return undefined;
  }

  return {
    format: "jsonl",
    path: formatEpisodeLogPathForRun(outPath, episodeLogPath),
    episodes: records
  };
}

export function formatEpisodeLogPathForRun(outPath: string | undefined, episodeLogPath: string): string {
  if (!outPath) {
    return normalizePortablePath(episodeLogPath);
  }

  const runDir = dirname(resolve(outPath));
  const absoluteLogPath = resolve(episodeLogPath);
  const relativeLogPath = relative(runDir, absoluteLogPath);
  if (relativeLogPath && !relativeLogPath.startsWith("..") && !isAbsolute(relativeLogPath)) {
    return normalizePortablePath(relativeLogPath);
  }

  return normalizePortablePath(absoluteLogPath);
}

async function initializeEpisodeLog(options: Pick<DiscoveryShardOptions, "saveAll" | "episodeLogPath">): Promise<EpisodeLogWriteResult> {
  if (!options.saveAll) {
    return { records: 0 };
  }

  if (!options.episodeLogPath) {
    throw new Error("Use --out or --episode-log with --save-all so discovery has a sidecar path for all episode replays.");
  }

  await mkdir(dirname(options.episodeLogPath), { recursive: true });
  await writeFile(options.episodeLogPath, "", "utf8");
  return { path: options.episodeLogPath, records: 0 };
}

async function appendDiscoveryEpisodeLog(path: string | undefined, episode: DiscoveryEpisode): Promise<number> {
  if (!path) {
    return 0;
  }

  const record: EpisodeLogRecord = {
    episode: episode.session.agent?.episode ?? 0,
    session: episode.session,
    overlaySamples: episode.overlaySamples
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return 1;
}

function createShardEpisodeLogPath(finalEpisodeLogPath: string, workerIndex: number): string {
  const finalPath = resolve(finalEpisodeLogPath);
  const parsed = parse(finalPath);
  const extension = parsed.ext || ".jsonl";
  return join(parsed.dir, `.${parsed.name}.worker-${workerIndex}-${process.pid}.tmp${extension}`);
}

async function mergeEpisodeLogFiles(shardPaths: string[], finalEpisodeLogPath: string): Promise<void> {
  await mkdir(dirname(finalEpisodeLogPath), { recursive: true });
  await writeFile(finalEpisodeLogPath, "", "utf8");

  for (const shardPath of shardPaths) {
    try {
      const text = await readFile(shardPath, "utf8");
      if (text.length > 0) {
        await appendFile(finalEpisodeLogPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    } finally {
      await rm(shardPath, { force: true });
    }
  }
}

export function createOverlaySamples(samples: FrameSample[], findings: Finding[] = []): OverlaySample[] {
  const firstDeathIndex = samples.findIndex((sample) => sample.dying);
  const liveSamples = firstDeathIndex >= 0 ? samples.slice(0, firstDeathIndex + 1) : samples;
  const findingWindows = findings.map((finding) => ({
    start: finding.frameStart,
    end: finding.frameEnd
  }));

  return liveSamples
    .filter((sample, index) => {
      if (index === 0 || index === liveSamples.length - 1 || sample.frame % 4 === 0 || sample.dying) {
        return true;
      }

      return findingWindows.some((window) => sample.frame >= window.start && sample.frame <= window.end);
    })
    .map((sample) => ({
      frame: sample.frame,
      rawWorld: sample.rawWorld,
      rawLevel: sample.rawLevel,
      world: sample.world,
      level: sample.level,
      currentScreen: sample.currentScreen,
      progress: sample.progress,
      x: sample.xOnScreen,
      y: sample.yOnScreen,
      dying: sample.dying
    }));
}

function normalizePortablePath(path: string): string {
  return path.split(sep).join("/");
}

export function expandMacroTrace(trace: MacroStep[], durationFrames: number): ReproInputRange[] {
  const ranges: ReproInputRange[] = [];
  let frame = 1;

  for (const step of normalizeTraceDuration(trace, durationFrames)) {
    const frameStart = frame;
    const frameEnd = Math.min(durationFrames, frame + step.frames - 1);
    if (frameEnd < frameStart) {
      continue;
    }

    const buttons = buttonsForMacro(step.action, frameStart);
    const previous = ranges.at(-1);
    if (previous && sameButtons(previous.buttons, buttons) && previous.frameEnd + 1 === frameStart) {
      previous.frameEnd = frameEnd;
    } else {
      ranges.push({ frameStart, frameEnd, buttons });
    }
    frame = frameEnd + 1;
    if (frame > durationFrames) {
      break;
    }
  }

  return ranges;
}

export function generateFreshMacroTrace(random: () => number, durationFrames: number): MacroStep[] {
  const trace: MacroStep[] = [];
  let frames = 0;

  while (frames < durationFrames) {
    const action = weightedAction(random);
    const stepFrames = randomInteger(random, 12, action === "idle" ? 50 : 110);
    trace.push({ action, frames: stepFrames });
    frames += stepFrames;
  }

  return normalizeTraceDuration(trace, durationFrames);
}

export function generateFreshFullRunTrace(
  random: () => number,
  durationFrames: number,
  focus: DiscoveryFocus = "balanced"
): { trace: MacroStep[]; mutation: string } {
  const explorationRate =
    focus === "coverage" ? 0.12 : focus === "bugs" ? 0.08 : focus === "progress" ? 0.015 : FULL_RUN_FRESH_EXPLORATION_RATE;
  if (random() < explorationRate) {
    return { trace: generateForwardBiasedMacroTrace(random, durationFrames, focus !== "progress"), mutation: "fresh-forward-branch" };
  }

  return { trace: generateForwardRouteTrace(random, durationFrames), mutation: "fresh-route-first" };
}

export function generateForwardRouteTrace(random: () => number, durationFrames: number): MacroStep[] {
  const trace: MacroStep[] = [];
  const add = (action: MacroActionName, frames: number) => {
    if (frames > 0) {
      trace.push({ action, frames });
    }
  };

  add("right-b", 245 + randomInteger(random, -18, 18));
  add("pipe-hold", 160 + randomInteger(random, -16, 20));
  add("right-b", 105 + randomInteger(random, -16, 20));

  let frames = trace.reduce(sumFrames, 0);
  while (frames < durationFrames) {
    const jumpFrames = randomInteger(random, 16, 30);
    const runFrames = randomInteger(random, 10, 30);
    add("jump-right", jumpFrames);
    add("right-b", runFrames);
    frames += jumpFrames + runFrames;
  }

  return normalizeTraceDuration(trace, durationFrames);
}

function generateForwardBiasedMacroTrace(
  random: () => number,
  durationFrames: number,
  allowExploration: boolean
): MacroStep[] {
  const trace: MacroStep[] = [];
  let frames = 0;

  while (frames < durationFrames) {
    const action = weightedFullRunAction(random, allowExploration);
    const stepFrames = randomInteger(random, 10, action === "right-b" ? 72 : 46);
    trace.push({ action, frames: stepFrames });
    frames += stepFrames;
  }

  return normalizeTraceDuration(trace, durationFrames);
}

export function macroTraceFromReplayInputs(ranges: ReproInputRange[]): MacroStep[] {
  const trace = ranges
    .filter((range) => range.frameEnd >= range.frameStart)
    .map((range) => ({
      action: macroActionForButtons(range.buttons),
      frames: range.frameEnd - range.frameStart + 1
    }));

  return mergeAdjacentMacroSteps(trace);
}

function createRlDiscoveryEpisode(options: {
  id: string;
  globalEpisode: number;
  phase: "rl-explore" | "go-explore-bug";
  mutation: string;
  parentId?: string;
  execution: ReturnType<typeof executeEpisode>;
  globalCells: Set<string>;
  globalCoverageGoals: Set<string>;
  focus: DiscoveryFocus;
  bugTarget: BugTarget;
  rlEpsilon?: number;
  rlStateCount?: number;
  rlUpdateCount?: number;
}): DiscoveryEpisode {
  const session = sessionFromExecution("coverage-explorer", options.execution);
  const actualTrace = macroTraceFromReplayInputs(options.execution.replayInputs);
  const obstacleWindow = detectForwardObstacleWindow(options.execution.samples, options.execution.replayInputs);
  const overlaySamples = createOverlaySamples(options.execution.samples, session.findings);
  const cells = new Set(options.execution.samples.map(createArchiveCell));
  const newCells = countNewCells(cells, options.globalCells);
  const coverageGoalsHit = [...collectCoverageGoals(options.execution.samples)].sort();
  const coverageScore = scoreCoverageGoals(coverageGoalsHit, options.globalCoverageGoals);
  const bugScore = scoreFindings(session.findings);
  const milestoneFrames = computeMilestoneFrames(options.execution.samples);
  const speedScore = scoreSpeedMilestones(milestoneFrames, session.metrics.deaths);
  const routeScore = scoreRouteEfficiency(options.execution.samples, session.metrics.deaths);
  const roomStats = computeRoomStats(options.execution.samples);
  const roomScore = scoreRooms(roomStats);
  const gameScoreStats = computeGameScoreStats(options.execution.samples);
  const gameScore = scoreGameScoreDelta(gameScoreStats.delta);
  const progressScore = scoreDiscoveryProgress(session, cells, newCells, {
    coverageScore,
    routeScore,
    speedScore,
    roomScore,
    gameScore
  });
  const score = scoreDiscoveryEpisode(session, cells, newCells, bugScore, {
    coverageScore,
    routeScore,
    speedScore,
    roomScore,
    gameScore
  });
  const targetReached = session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS;
  session.agent = {
    type: "rl-go-explore-hybrid",
    episode: options.globalEpisode,
    episodeId: options.id,
    parentId: options.parentId,
    startFrame: 0,
    prefixFrames: 0,
    suffixFrames: options.execution.samples.length,
    score,
    newCells,
    cellsVisited: options.execution.samples.length,
    uniqueCells: cells.size,
    bugScore,
    progressScore,
    coverageScore,
    coverageGoalsHit,
    routeScore,
    speedScore,
    roomScore,
    gameScore,
    gameScoreDelta: gameScoreStats.delta,
    milestoneFrames,
    roomTransitions: roomStats.transitions,
    roomsReached: roomStats.rooms,
    progressDelta: session.metrics.maxProgress,
    targetReached,
    obstacleFrame: obstacleWindow?.mutationFrame,
    obstacleProgress: obstacleWindow?.progress,
    obstacleDurationFrames: obstacleWindow?.durationFrames,
    obstacleReason: obstacleWindow?.reason,
    phase: options.phase,
    rlEpsilon: options.rlEpsilon,
    rlStateCount: options.rlStateCount,
    rlUpdateCount: options.rlUpdateCount,
    focus: options.focus,
    bugTarget: options.bugTarget,
    mutation: options.mutation
  };

  return {
    id: options.id,
    parentId: options.parentId,
    trace: actualTrace,
    session,
    cells,
    newCells,
    bugScore,
    progressScore,
    coverageScore,
    coverageGoalsHit,
    routeScore,
    speedScore,
    roomScore,
    gameScore,
    gameScoreDelta: gameScoreStats.delta,
    milestoneFrames,
    roomTransitions: roomStats.transitions,
    roomsReached: roomStats.rooms,
    score,
    progressDelta: session.metrics.maxProgress,
    targetReached,
    obstacleWindow,
    mutation: options.mutation,
    overlaySamples
  };
}

interface RlActionOption {
  action: MacroActionName;
  frames: number;
  label: string;
  weight: number;
}

const RL_ACTIONS: RlActionOption[] = [
  { action: "right-b", frames: 18, label: "run-short", weight: 5 },
  { action: "right-b", frames: 42, label: "run-long", weight: 4 },
  { action: "jump-right", frames: 14, label: "hop-early", weight: 5 },
  { action: "jump-right", frames: 28, label: "jump-full", weight: 5 },
  { action: "jump-right", frames: 40, label: "jump-hold", weight: 3 },
  { action: "down-right", frames: 18, label: "duck-forward", weight: 1.4 },
  { action: "pipe-hold", frames: 34, label: "pipe-hold", weight: 1.4 },
  { action: "climb-right", frames: 24, label: "climb-right", weight: 1.1 },
  { action: "oscillate", frames: 12, label: "micro-oscillate", weight: 0.2 },
  { action: "idle", frames: 8, label: "wait-tiny", weight: 0.12 }
];

class TabularRlPolicy {
  private readonly values = new Map<string, number[]>();
  updateCount = 0;

  get stateCount(): number {
    return this.values.size;
  }

  actionValues(state: string): number[] {
    let values = this.values.get(state);
    if (!values) {
      values = Array.from({ length: RL_ACTIONS.length }, () => 0);
      this.values.set(state, values);
    }
    return values;
  }

  update(state: string, actionIndex: number, reward: number, nextState: string): void {
    const values = this.actionValues(state);
    const nextValues = this.actionValues(nextState);
    const alpha = 0.22;
    const gamma = 0.9;
    const target = reward + gamma * Math.max(...nextValues);
    values[actionIndex] += alpha * (target - values[actionIndex]);
    this.updateCount += 1;
  }
}

class RlExplorationController {
  private current:
    | {
        state: string;
        actionIndex: number;
        framesRemaining: number;
        startProgress: number;
        startScore: number;
        startRoomId: string;
      }
    | undefined;
  private previousProgress = 0;
  private noProgressFrames = 0;

  constructor(
    private readonly policy: TabularRlPolicy,
    private readonly random: () => number,
    private readonly epsilon: number,
    private readonly focus: DiscoveryFocus
  ) {}

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    this.updateProgressWindow(snapshot);
    if (snapshot.dying) {
      this.closeAction(snapshot, -220);
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.closeAction(snapshot, 8);
      return ["UP", "RIGHT"];
    }

    if (!this.current || this.current.framesRemaining <= 0) {
      this.closeAction(snapshot, 0);
      const state = this.stateKey(snapshot);
      const actionIndex = this.chooseActionIndex(snapshot, state, frame, durationFrames);
      const option = RL_ACTIONS[actionIndex]!;
      this.current = {
        state,
        actionIndex,
        framesRemaining: this.actionFrames(option),
        startProgress: snapshot.progress,
        startScore: snapshot.score,
        startRoomId: snapshot.roomId
      };
    }

    this.current.framesRemaining -= 1;
    return buttonsForMacro(RL_ACTIONS[this.current.actionIndex]!.action, frame);
  }

  finish(snapshot: SmbRamSnapshot | undefined): void {
    if (snapshot) {
      this.closeAction(snapshot, snapshot.dying ? -220 : 0);
    }
  }

  private chooseActionIndex(snapshot: SmbRamSnapshot, state: string, frame: number, durationFrames: number): number {
    const allowRisky = this.focus === "coverage" || this.focus === "bugs" || snapshot.progress >= VINE_WARP_TARGET_PROGRESS || frame > durationFrames * 0.35;
    if (this.random() < this.epsilon) {
      return this.weightedActionIndex(allowRisky);
    }

    const values = this.policy.actionValues(state);
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const [index, value] of values.entries()) {
      const option = RL_ACTIONS[index]!;
      if (!allowRisky && (option.action === "idle" || option.action === "oscillate")) {
        continue;
      }
      const tieBreaker = this.random() * 0.05;
      const prior = option.action === "jump-right" ? 0.18 : option.action === "right-b" ? 0.14 : 0;
      const adjusted = value + prior + tieBreaker;
      if (adjusted > bestValue) {
        bestValue = adjusted;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  private weightedActionIndex(allowRisky: boolean): number {
    const weights = RL_ACTIONS.map((option) => {
      if (!allowRisky && (option.action === "idle" || option.action === "oscillate")) {
        return 0;
      }
      return option.weight;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = this.random() * total;
    for (const [index, weight] of weights.entries()) {
      pick -= weight;
      if (pick <= 0) {
        return index;
      }
    }
    return 0;
  }

  private actionFrames(option: RlActionOption): number {
    return clampInteger(option.frames + randomInteger(this.random, -6, 10), RL_ACTION_MIN_FRAMES, RL_ACTION_MAX_FRAMES);
  }

  private closeAction(snapshot: SmbRamSnapshot, bonus: number): void {
    if (!this.current) {
      return;
    }

    const progressDelta = snapshot.progress - this.current.startProgress;
    const scoreDelta = Math.max(0, snapshot.score - this.current.startScore);
    const roomBonus = snapshot.roomId !== this.current.startRoomId ? 36 : 0;
    const targetBonus = snapshot.progress >= VINE_WARP_TARGET_PROGRESS ? 42 : 0;
    const backwardPenalty = progressDelta < 0 ? Math.abs(progressDelta) * 2.4 : 0;
    const stallPenalty = progressDelta <= 1 && this.noProgressFrames > 24 ? 18 : 0;
    const reward =
      progressDelta * 0.95 +
      scoreDelta / 28 +
      roomBonus +
      targetBonus +
      (progressDelta > 8 ? 8 : 0) +
      bonus -
      backwardPenalty -
      stallPenalty;
    this.policy.update(this.current.state, this.current.actionIndex, reward, this.stateKey(snapshot));
    this.current = undefined;
  }

  private updateProgressWindow(snapshot: SmbRamSnapshot): void {
    if (snapshot.progress > this.previousProgress + 1) {
      this.noProgressFrames = 0;
    } else if (snapshot.levelLoading === 0 && snapshot.gameMode === 1) {
      this.noProgressFrames += 1;
    }
    this.previousProgress = Math.max(this.previousProgress, snapshot.progress);
  }

  private stateKey(snapshot: SmbRamSnapshot): string {
    return [
      `w${snapshot.rawWorld}`,
      `l${snapshot.rawLevel}`,
      `p${Math.floor(snapshot.progress / 96)}`,
      `x${Math.floor(snapshot.xOnScreen / 32)}`,
      `y${Math.floor(snapshot.yOnScreen / 48)}`,
      snapshot.onVine || snapshot.vineVisible ? "vine" : "no-vine",
      snapshot.pipeInteraction || snapshot.enteringPipe ? "pipe" : "no-pipe",
      snapshot.warpZoneVisible ? "warp" : "no-warp",
      this.noProgressFrames > 30 ? "stuck" : "moving"
    ].join("|");
  }
}

function rlExplorationRate(episode: number, totalEpisodes: number, focus: DiscoveryFocus): number {
  const start = focus === "coverage" ? 0.62 : focus === "bugs" ? 0.55 : 0.48;
  const end = focus === "progress" ? 0.12 : 0.18;
  const t = totalEpisodes <= 1 ? 1 : (episode - 1) / (totalEpisodes - 1);
  return Number((start + (end - start) * t).toFixed(3));
}

export function mutateMacroTrace(
  parent: MacroStep[],
  random: () => number,
  durationFrames: number
): { trace: MacroStep[]; mutation: string } {
  const trace = parent.map((step) => ({ ...step }));
  const roll = random();

  if (trace.length === 0 || roll < 0.25) {
    const index = randomInteger(random, 0, Math.max(0, trace.length));
    trace.splice(index, 0, {
      action: weightedAction(random),
      frames: randomInteger(random, 12, 90)
    });
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "insert-macro" };
  }

  if (roll < 0.5) {
    const index = randomInteger(random, 0, trace.length - 1);
    trace[index] = {
      action: weightedAction(random),
      frames: trace[index]?.frames ?? 40
    };
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "replace-macro" };
  }

  if (roll < 0.75) {
    const index = randomInteger(random, 0, trace.length - 1);
    const step = trace[index]!;
    trace[index] = {
      ...step,
      frames: Math.max(6, step.frames + randomInteger(random, -24, 36))
    };
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "duration-jitter" };
  }

  const spliceAt = randomInteger(random, 0, trace.length - 1);
  const freshTail = generateFreshMacroTrace(random, Math.max(30, durationFrames - trace.slice(0, spliceAt).reduce(sumFrames, 0)));
  return {
    trace: normalizeTraceDuration([...trace.slice(0, spliceAt), ...freshTail], durationFrames),
    mutation: "splice-and-jitter"
  };
}

export function createRouteSeedControllerConfig(seed = 1): ProgressControllerConfig {
  return {
    jumpInterval: 118 + Math.abs(seed % 11),
    jumpDuration: 24,
    jumpOffset: 44 + Math.abs(seed % 17),
    stuckFrames: 38,
    recoveryFrames: 46,
    pipeHoldFrames: 0,
    exploratoryLeftEvery: 0,
    exploratoryLeftFrames: 0
  };
}

export function createBaselineProgressControllerConfig(seed = 1): ProgressControllerConfig {
  return {
    jumpInterval: 130 + Math.abs(seed % 31),
    jumpDuration: 20,
    jumpOffset: 25 + Math.abs(seed % 29),
    stuckFrames: 46,
    recoveryFrames: 38,
    pipeHoldFrames: 28,
    exploratoryLeftEvery: 720 + Math.abs(seed % 180),
    exploratoryLeftFrames: 12
  };
}

export function mutateProgressControllerConfig(
  parent: ProgressControllerConfig,
  random: () => number,
  parentProgress = 0,
  bestProgress = 0
): { config: ProgressControllerConfig; mutation: string } {
  const config = { ...parent };
  const progressPressure = bestProgress < VINE_WARP_TARGET_PROGRESS || parentProgress < VINE_WARP_TARGET_PROGRESS;
  const roll = random();

  if (roll < 0.28) {
    config.jumpInterval = clampInteger(config.jumpInterval + randomInteger(random, -24, 20), 70, 190);
    config.jumpOffset = clampInteger(config.jumpOffset + randomInteger(random, -22, 22), 0, config.jumpInterval - 1);
    return { config: progressPressure ? progressBiasedConfig(config) : config, mutation: "jump-timing-jitter" };
  }

  if (roll < 0.52) {
    config.jumpDuration = clampInteger(config.jumpDuration + randomInteger(random, -8, 10), 10, 46);
    config.stuckFrames = clampInteger(config.stuckFrames + randomInteger(random, -14, 18), 18, 90);
    return { config: progressPressure ? progressBiasedConfig(config) : config, mutation: "stuck-recovery-jitter" };
  }

  if (roll < 0.76) {
    config.pipeHoldFrames = clampInteger(config.pipeHoldFrames + randomInteger(random, -10, 18), 12, 70);
    return { config: progressPressure ? progressBiasedConfig(config) : config, mutation: "pipe-window-jitter" };
  }

  config.exploratoryLeftEvery = progressPressure ? 0 : clampInteger(config.exploratoryLeftEvery + randomInteger(random, -180, 220), 240, 1200);
  config.exploratoryLeftFrames = progressPressure ? 0 : clampInteger(config.exploratoryLeftFrames + randomInteger(random, -6, 12), 4, 36);
  return { config, mutation: progressPressure ? "progress-route-controller" : "exploration-controller-jitter" };
}

export class ProgressController {
  private bestProgress = 0;
  private noProgressFrames = 0;
  private recoveryFramesRemaining = 0;
  private pipeFramesRemaining = 0;
  private subAreaPulseFrames = 0;
  private subAreaFrontierFrames = 0;

  constructor(private readonly config: ProgressControllerConfig) {}

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.noProgressFrames = 0;
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      return ["UP", "RIGHT"];
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      return ["DOWN", "RIGHT"];
    }

    if (snapshot.playerStateName === "left-edge" || snapshot.playerStateName === "entering-area") {
      return ["B", "RIGHT"];
    }

    const subAreaButtons = this.buttonsForWorld42SubArea(snapshot);
    if (subAreaButtons) {
      return subAreaButtons;
    }

    if (snapshot.progress > this.bestProgress + 1) {
      this.bestProgress = snapshot.progress;
      this.noProgressFrames = 0;
    } else if (snapshot.levelLoading === 0 && snapshot.gameMode === 1) {
      this.noProgressFrames += 1;
    }

    if (this.config.pipeHoldFrames > 0 && snapshot.pipeInteraction && this.noProgressFrames > Math.floor(this.config.stuckFrames / 2)) {
      this.pipeFramesRemaining = this.config.pipeHoldFrames;
    }

    if (this.noProgressFrames >= this.config.stuckFrames) {
      this.recoveryFramesRemaining = this.config.recoveryFrames;
      this.noProgressFrames = 0;
    }

    if (this.pipeFramesRemaining > 0) {
      this.pipeFramesRemaining -= 1;
      return ["B", "DOWN", "RIGHT"];
    }

    if (this.recoveryFramesRemaining > 0) {
      this.recoveryFramesRemaining -= 1;
      const halfway = Math.floor(this.config.recoveryFrames / 2);
      return this.allowsLeftRecovery() && this.recoveryFramesRemaining > halfway ? ["A", "B", "LEFT"] : ["A", "B", "RIGHT"];
    }

    if (this.shouldExploreLeft(frame, durationFrames, snapshot)) {
      return frame % 4 === 0 ? ["A", "B", "LEFT"] : ["B", "LEFT"];
    }

    if (this.shouldJump(frame, snapshot)) {
      return ["A", "B", "RIGHT"];
    }

    return ["B", "RIGHT"];
  }

  private shouldJump(frame: number, snapshot: SmbRamSnapshot): boolean {
    if (this.shouldJumpForWorld42Progress(snapshot)) {
      return true;
    }

    const cycle = (frame + this.config.jumpOffset) % this.config.jumpInterval;
    if (cycle < this.config.jumpDuration) {
      return true;
    }

    if (snapshot.hiddenBlockTileCount > 0 && cycle < this.config.jumpDuration + 16) {
      return true;
    }

    if (snapshot.enemyTypes.some((type) => type > 0) && cycle < this.config.jumpDuration + 10) {
      return true;
    }

    return this.noProgressFrames > Math.floor(this.config.stuckFrames * 0.6);
  }

  private shouldJumpForWorld42Progress(snapshot: SmbRamSnapshot): boolean {
    const isWorld42Area =
      (snapshot.world === 4 && (snapshot.level === 2 || snapshot.level === 3)) ||
      (snapshot.rawWorld === 3 && (snapshot.rawLevel === 1 || snapshot.rawLevel === 2));

    if (!isWorld42Area || snapshot.progress >= VINE_WARP_TARGET_PROGRESS) {
      return false;
    }

    const progress = snapshot.progress;
    return (
      (progress >= 160 && progress <= 250) ||
      (progress >= 245 && progress <= 390) ||
      (progress >= 430 && progress <= 610) ||
      (progress >= 615 && progress <= 730) ||
      (progress >= 780 && progress <= 875) ||
      (progress >= 900 && progress <= 980)
    );
  }

  private shouldExploreLeft(frame: number, durationFrames: number, snapshot: SmbRamSnapshot): boolean {
    if (snapshot.progress < VINE_WARP_TARGET_PROGRESS || this.config.exploratoryLeftEvery <= 0) {
      return false;
    }

    if (frame < durationFrames * 0.25) {
      return false;
    }

    return frame % this.config.exploratoryLeftEvery < this.config.exploratoryLeftFrames;
  }

  private buttonsForWorld42SubArea(snapshot: SmbRamSnapshot): ButtonName[] | undefined {
    if (!isWorld42SubArea(snapshot) || snapshot.playerStateName !== "normal" || snapshot.progress >= VINE_WARP_TARGET_PROGRESS) {
      if (!isWorld42SubArea(snapshot)) {
        this.resetSubAreaRoute();
        return undefined;
      }

      if (snapshot.progress >= VINE_WARP_TARGET_PROGRESS && snapshot.playerStateName === "normal") {
        return this.buttonsForWorld42Frontier(snapshot);
      }

      return undefined;
    }

    if (snapshot.progress <= SUB_AREA_OPENING_PROGRESS) {
      this.resetSubAreaRoute();
      return ["B", "RIGHT"];
    }

    this.subAreaPulseFrames += 1;
    return (this.subAreaPulseFrames - 1) % SUB_AREA_PULSE_PERIOD_FRAMES < SUB_AREA_PULSE_ON_FRAMES ? ["A", "B", "RIGHT"] : [];
  }

  private buttonsForWorld42Frontier(snapshot: SmbRamSnapshot): ButtonName[] {
    this.subAreaPulseFrames = 0;
    this.subAreaFrontierFrames += 1;

    if (snapshot.onVine || snapshot.vineVisible) {
      return ["UP", "RIGHT"];
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      return ["DOWN", "RIGHT"];
    }

    if (snapshot.progress < SUB_AREA_ROUTE_HAZARD_PROGRESS) {
      return this.subAreaFrontierFrames % SUB_AREA_FRONTIER_JUMP_PERIOD_FRAMES < SUB_AREA_FRONTIER_JUMP_ON_FRAMES
        ? ["A", "B", "RIGHT"]
        : ["B", "RIGHT"];
    }

    if (snapshot.progress < SUB_AREA_ROUTE_SAFE_FRONTIER_PROGRESS) {
      return ["A", "B", "RIGHT"];
    }

    return ["B", "RIGHT"];
  }

  private resetSubAreaRoute(): void {
    this.subAreaPulseFrames = 0;
    this.subAreaFrontierFrames = 0;
  }

  private allowsLeftRecovery(): boolean {
    return this.config.exploratoryLeftEvery > 0 && this.config.exploratoryLeftFrames > 0;
  }
}

export class CheckpointActionFuzzer {
  private readonly fallback: ProgressController;
  private remainingFrames = 0;
  private currentButtons: ButtonName[] = ["B", "RIGHT"];

  constructor(
    private readonly random: () => number,
    fallbackConfig: ProgressControllerConfig
  ) {
    this.fallback = new ProgressController(fallbackConfig);
  }

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.remainingFrames = 0;
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.remainingFrames = 0;
      return ["UP", "RIGHT"];
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      this.remainingFrames = 0;
      return ["DOWN", "RIGHT"];
    }

    if (this.remainingFrames <= 0) {
      this.currentButtons = this.chooseButtons(frame, snapshot, durationFrames);
      this.remainingFrames = this.chooseDuration(snapshot);
    }

    this.remainingFrames -= 1;
    return this.currentButtons;
  }

  private chooseButtons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    const fallbackButtons = this.fallback.buttons(frame, snapshot, durationFrames);

    if (isWorld42SubArea(snapshot) && snapshot.progress < VINE_WARP_TARGET_PROGRESS && this.random() < 0.86) {
      return fallbackButtons;
    }

    if (snapshot.progress < 150 && this.random() < 0.85) {
      return fallbackButtons;
    }

    if (snapshot.progress < VINE_WARP_TARGET_PROGRESS) {
      return this.chooseProgressButtons(fallbackButtons);
    }

    return this.chooseExplorationButtons(fallbackButtons);
  }

  private chooseProgressButtons(fallbackButtons: ButtonName[]): ButtonName[] {
    const roll = this.random();
    if (roll < 0.34) return fallbackButtons;
    if (roll < 0.58) return ["A", "B", "RIGHT"];
    if (roll < 0.74) return ["B", "RIGHT"];
    if (roll < 0.88) return ["A", "RIGHT"];
    if (roll < 0.96) return ["RIGHT"];
    return ["B", "DOWN", "RIGHT"];
  }

  private chooseExplorationButtons(fallbackButtons: ButtonName[]): ButtonName[] {
    const roll = this.random();
    if (roll < 0.42) return fallbackButtons;
    if (roll < 0.6) return ["A", "B", "RIGHT"];
    if (roll < 0.72) return ["B", "DOWN", "RIGHT"];
    if (roll < 0.84) return ["B", "LEFT"];
    if (roll < 0.94) return ["A", "LEFT"];
    return [];
  }

  private chooseDuration(snapshot: SmbRamSnapshot): number {
    const max = snapshot.progress < VINE_WARP_TARGET_PROGRESS ? 22 : 34;
    return randomInteger(this.random, 4, max);
  }
}

export class WarpZoneProbeController {
  private readonly fallback: ProgressController;
  private remainingFrames = 0;
  private currentButtons: ButtonName[] = ["B", "RIGHT"];

  constructor(
    private readonly random: () => number,
    fallbackConfig: ProgressControllerConfig
  ) {
    this.fallback = new ProgressController(fallbackConfig);
  }

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.remainingFrames = 0;
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.remainingFrames = 0;
      return this.random() < 0.75 ? ["UP", "RIGHT"] : ["A", "B", "RIGHT"];
    }

    if (this.remainingFrames <= 0) {
      this.currentButtons = this.chooseButtons(frame, snapshot, durationFrames);
      this.remainingFrames = this.chooseDuration(snapshot);
    }

    this.remainingFrames -= 1;
    return this.currentButtons;
  }

  private chooseButtons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    const fallbackButtons = this.fallback.buttons(frame, snapshot, durationFrames);
    const hotspot = snapshot.pipeInteraction || snapshot.warpZoneVisible || snapshot.hiddenBlockTileCount > 0 || snapshot.enteringPipe || snapshot.changeAreaTimer > 0;
    if (!hotspot && this.random() < 0.68) {
      return fallbackButtons;
    }

    const roll = this.random();
    if (roll < 0.14) return [];
    if (roll < 0.32) return ["DOWN", "RIGHT"];
    if (roll < 0.5) return ["B", "DOWN", "RIGHT"];
    if (roll < 0.66) return ["A", "B", "RIGHT"];
    if (roll < 0.82) return ["UP", "RIGHT"];
    if (roll < 0.92) return ["B", "RIGHT"];
    return fallbackButtons;
  }

  private chooseDuration(snapshot: SmbRamSnapshot): number {
    const max = snapshot.pipeInteraction || snapshot.warpZoneVisible || snapshot.changeAreaTimer > 0 ? 20 : 32;
    return randomInteger(this.random, 4, max);
  }
}

export class WallClipProbeController {
  private readonly fallback: ProgressController;
  private remainingFrames = 0;
  private currentButtons: ButtonName[] = ["B", "RIGHT"];

  constructor(
    private readonly random: () => number,
    fallbackConfig: ProgressControllerConfig
  ) {
    this.fallback = new ProgressController(fallbackConfig);
  }

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.remainingFrames = 0;
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.remainingFrames = 0;
      return ["UP", "RIGHT"];
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      this.remainingFrames = 0;
      return ["DOWN", "RIGHT"];
    }

    if (this.remainingFrames <= 0) {
      this.currentButtons = this.chooseButtons(frame, snapshot, durationFrames);
      this.remainingFrames = this.chooseDuration(snapshot);
    }

    this.remainingFrames -= 1;
    return this.currentButtons;
  }

  private chooseButtons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    const fallbackButtons = this.fallback.buttons(frame, snapshot, durationFrames);
    const hotspot =
      snapshot.pipeInteraction ||
      snapshot.pipeTileCount > 0 ||
      snapshot.scrollLock > 0 ||
      snapshot.playerCollisionBits !== 0xff ||
      snapshot.playerHitDetectFlag !== 0;

    if (!hotspot && this.random() < 0.62) {
      return fallbackButtons;
    }

    const roll = this.random();
    if (roll < 0.24) return ["B", "RIGHT"];
    if (roll < 0.42) return ["RIGHT"];
    if (roll < 0.58) return ["DOWN", "RIGHT"];
    if (roll < 0.72) return ["A", "B", "RIGHT"];
    if (roll < 0.84) return ["B", "LEFT"];
    if (roll < 0.94) return [];
    return fallbackButtons;
  }

  private chooseDuration(snapshot: SmbRamSnapshot): number {
    const max = snapshot.pipeInteraction || snapshot.scrollLock > 0 ? 34 : 24;
    return randomInteger(this.random, 6, max);
  }
}

export class WallClipTrickController {
  private readonly fallback: ProgressController;
  private trickFrames = 0;
  private armed = false;
  private recoveryFrames = 0;
  private recoveredFromStall = false;

  constructor(
    private readonly random: () => number,
    fallbackConfig: ProgressControllerConfig
  ) {
    this.fallback = new ProgressController(progressBiasedConfig(fallbackConfig));
  }

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.trickFrames = 0;
      this.armed = false;
      this.recoveryFrames = 0;
      this.recoveredFromStall = false;
      return [];
    }

    if (snapshot.playerStateName === "left-edge" || snapshot.playerStateName === "entering-area" || snapshot.levelLoading > 0) {
      return ["B", "RIGHT"];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.armed = true;
      return this.clipSequence(snapshot);
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      return ["DOWN", "RIGHT"];
    }

    if (!this.armed && this.shouldArmClip(snapshot)) {
      this.armed = true;
      this.trickFrames = 0;
      this.recoveryFrames = 0;
      this.recoveredFromStall = false;
    }

    if (this.armed) {
      return this.clipSequence(snapshot);
    }

    return this.approachButtons(frame, snapshot, durationFrames);
  }

  private shouldArmClip(snapshot: SmbRamSnapshot): boolean {
    const geometryPressure =
      snapshot.pipeInteraction ||
      snapshot.pipeTileCount > 0 ||
      snapshot.hiddenBlockTileCount > 0 ||
      snapshot.scrollLock > 0 ||
      snapshot.playerCollisionBits !== 0xff ||
      snapshot.playerHitDetectFlag !== 0;
    const wallClipRegion =
      snapshot.progress >= 500 ||
      (isWorld42SubArea(snapshot) && snapshot.progress >= 430) ||
      snapshot.vineVisible ||
      snapshot.warpZoneVisible;

    return wallClipRegion && geometryPressure;
  }

  private approachButtons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.progress < 150) {
      return ["B", "RIGHT"];
    }

    if (this.needsUpperRouteJump(snapshot)) {
      return ["A", "B", "RIGHT"];
    }

    if (snapshot.pipeInteraction || snapshot.pipeTileCount > 0) {
      return ["B", "RIGHT"];
    }

    return this.fallback.buttons(frame, snapshot, durationFrames);
  }

  private needsUpperRouteJump(snapshot: SmbRamSnapshot): boolean {
    const progress = snapshot.progress;
    return (
      (progress >= 160 && progress <= 390) ||
      (progress >= 430 && progress <= 620) ||
      (progress >= 780 && progress <= 980) ||
      (isWorld42SubArea(snapshot) && progress >= 240 && progress < VINE_WARP_TARGET_PROGRESS)
    );
  }

  private clipSequence(snapshot: SmbRamSnapshot): ButtonName[] {
    this.trickFrames += 1;

    if (snapshot.horizontalSpeedAbs > 1 || !snapshot.pipeInteraction) {
      this.recoveredFromStall = false;
    }

    if (snapshot.horizontalSpeedAbs <= 1 && snapshot.pipeInteraction && !this.recoveredFromStall && this.recoveryFrames <= 0) {
      this.recoveryFrames = 10;
      this.recoveredFromStall = true;
    }

    if (this.recoveryFrames > 0) {
      this.recoveryFrames -= 1;
      return this.recoveryFrames > 5 ? ["A", "B", "LEFT"] : ["A", "B", "RIGHT"];
    }

    const phase = (this.trickFrames - 1) % 96;
    if (phase < 18) return ["B", "RIGHT"];
    if (phase < 22) return ["RIGHT"];
    if (phase < 26) return ["B"];
    if (phase < 30) return ["B", "LEFT"];
    if (phase < 38) return ["B", "DOWN", "RIGHT"];
    if (phase < 56) return ["A", "B", "RIGHT"];
    if (phase < 62) return ["RIGHT"];
    if (phase < 70) return ["A", "RIGHT"];
    if (phase < 84) return ["A", "B", "RIGHT"];
    if (phase < 90) return ["B", "DOWN", "RIGHT"];
    return this.random() < 0.5 ? ["B", "RIGHT"] : ["RIGHT"];
  }
}

export class CoverageGoalController {
  private readonly fallback: ProgressController;
  private readonly missingGoals: Set<string>;
  private remainingFrames = 0;
  private currentButtons: ButtonName[] = ["B", "RIGHT"];

  constructor(
    private readonly random: () => number,
    fallbackConfig: ProgressControllerConfig,
    missingGoals: Iterable<string> = []
  ) {
    this.fallback = new ProgressController(fallbackConfig);
    this.missingGoals = new Set(missingGoals);
  }

  buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
      this.remainingFrames = 0;
      return [];
    }

    if (snapshot.onVine || snapshot.vineVisible) {
      this.remainingFrames = 0;
      return this.wants("hidden-vine") || this.wants("warp-zone") ? ["UP", "RIGHT"] : this.fallback.buttons(frame, snapshot, durationFrames);
    }

    if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
      this.remainingFrames = 0;
      return ["DOWN", "RIGHT"];
    }

    if (this.remainingFrames <= 0) {
      this.currentButtons = this.chooseButtons(frame, snapshot, durationFrames);
      this.remainingFrames = this.chooseDuration(snapshot);
    }

    this.remainingFrames -= 1;
    return this.currentButtons;
  }

  private chooseButtons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] {
    const fallbackButtons = this.fallback.buttons(frame, snapshot, durationFrames);
    const wantsUpper =
      this.wants("upper-block-route") || this.wants("high-route") || this.wants("hidden-blocks") || this.wants("hidden-vine");
    const wantsLower = this.wants("lower-route") || this.wants("opening") || this.wants("early-route");
    const wantsPipe = this.wants("warp-pipe") || this.wants("coin-room") || this.wants("pipe-hotspot") || this.wants("warp-zone");
    const wantsWall = this.wants("wall-clip-hotspot");

    if (wantsPipe && (snapshot.pipeInteraction || snapshot.pipeTileCount > 0) && this.random() < 0.62) {
      return this.random() < 0.55 ? ["DOWN", "RIGHT"] : ["B", "DOWN", "RIGHT"];
    }

    if (wantsWall && (snapshot.pipeInteraction || snapshot.scrollLock > 0) && this.random() < 0.58) {
      const roll = this.random();
      if (roll < 0.34) return ["B", "RIGHT"];
      if (roll < 0.58) return ["RIGHT"];
      if (roll < 0.76) return ["DOWN", "RIGHT"];
      return ["B", "LEFT"];
    }

    if (wantsUpper && snapshot.progress >= 160 && snapshot.progress < VINE_WARP_TARGET_PROGRESS && this.random() < 0.7) {
      return ["A", "B", "RIGHT"];
    }

    if (wantsLower && snapshot.progress < VINE_WARP_TARGET_PROGRESS && this.random() < 0.52) {
      return this.random() < 0.72 ? ["B", "RIGHT"] : ["RIGHT"];
    }

    if (snapshot.progress >= VINE_WARP_TARGET_PROGRESS && this.random() < 0.3) {
      return this.random() < 0.5 ? ["A", "B", "LEFT"] : ["B", "LEFT"];
    }

    if (this.random() < 0.68) {
      return fallbackButtons;
    }

    const roll = this.random();
    if (roll < 0.24) return ["A", "B", "RIGHT"];
    if (roll < 0.42) return ["B", "RIGHT"];
    if (roll < 0.58) return ["RIGHT"];
    if (roll < 0.72) return ["B", "DOWN", "RIGHT"];
    if (roll < 0.86 && snapshot.progress >= VINE_WARP_TARGET_PROGRESS) return ["A", "B", "LEFT"];
    return fallbackButtons;
  }

  private chooseDuration(snapshot: SmbRamSnapshot): number {
    if (snapshot.pipeInteraction || snapshot.scrollLock > 0) {
      return randomInteger(this.random, 6, 28);
    }
    return randomInteger(this.random, 8, snapshot.progress < VINE_WARP_TARGET_PROGRESS ? 30 : 44);
  }

  private wants(goal: string): boolean {
    return this.missingGoals.size === 0 || this.missingGoals.has(goal);
  }
}

function createGoExploreController(
  controlMode: GoExploreControlMode,
  random: () => number,
  controllerConfig: ProgressControllerConfig,
  missingCoverageGoals: Iterable<string> = []
): { buttons(frame: number, snapshot: SmbRamSnapshot, durationFrames: number): ButtonName[] } {
  if (controlMode === "action-fuzz") {
    return new CheckpointActionFuzzer(random, controllerConfig);
  }
  if (controlMode === "coverage-explore") {
    return new CoverageGoalController(random, controllerConfig, missingCoverageGoals);
  }
  if (controlMode === "warp-zone-probe") {
    return new WarpZoneProbeController(random, controllerConfig);
  }
  if (controlMode === "wall-clip-probe") {
    return new WallClipProbeController(random, controllerConfig);
  }
  if (controlMode === "wall-clip-trick") {
    return new WallClipTrickController(random, controllerConfig);
  }

  return new ProgressController(controllerConfig);
}

export function createArchiveCell(sample: Pick<
  SmbRamSnapshot,
  | "world"
  | "level"
  | "currentScreen"
  | "xOnScreen"
  | "yOnScreen"
  | "playerState"
  | "pipeInteraction"
  | "vineVisible"
  | "warpZoneVisible"
  | "enteringPipe"
  | "dying"
  | "levelLoading"
  | "enemyTypes"
>): string {
  const flags = [
    sample.pipeInteraction ? "pipe" : "no-pipe",
    sample.vineVisible ? "vine" : "no-vine",
    sample.warpZoneVisible ? "warp" : "no-warp",
    sample.enteringPipe ? "entering" : "free",
    sample.dying ? "dying" : "alive",
    sample.levelLoading ? "loading" : "active"
  ].join(".");
  const enemyMask = sample.enemyTypes.map((type) => (type > 0 ? "1" : "0")).join("");

  return [
    `w${sample.world}-${sample.level}`,
    `s${sample.currentScreen}`,
    `x${Math.floor(sample.xOnScreen / 32)}`,
    `y${Math.floor(sample.yOnScreen / 32)}`,
    `p${sample.playerState}`,
    flags,
    `e${enemyMask}`
  ].join("|");
}

export function classifyWorld42CoverageGoals(sample: Pick<
  SmbRamSnapshot,
  | "progress"
  | "currentScreen"
  | "yOnScreen"
  | "rawWorld"
  | "rawLevel"
  | "pipeInteraction"
  | "pipeTileCount"
  | "hiddenBlockTileCount"
  | "vineVisible"
  | "vineTileCount"
  | "onVine"
  | "warpZoneVisible"
  | "warpZoneControl"
  | "enteringPipe"
  | "changeAreaTimer"
  | "areaMusic"
  | "areaOffset"
  | "enemyTypes"
  | "scrollLock"
  | "playerCollisionBits"
  | "playerHitDetectFlag"
  | "dying"
>): Set<string> {
  const goals = new Set<string>();
  if (sample.dying) {
    return goals;
  }

  const progress = Math.max(0, sample.progress);
  const progressBucket = clampInteger(Math.floor(progress / 128), 0, 15);
  const screenBucket = clampInteger(sample.currentScreen, 0, 7);
  goals.add(`progress-${progressBucket.toString().padStart(2, "0")}`);
  goals.add(`screen-${screenBucket.toString().padStart(2, "0")}`);

  if (progress < 192) goals.add("opening");
  if (progress >= 192 && progress < 512) goals.add("early-route");
  if (progress >= 512 && progress < VINE_WARP_TARGET_PROGRESS) goals.add("mid-route");
  if (progress >= 640 || sample.hiddenBlockTileCount > 0 || sample.vineVisible) goals.add("vine-warp-approach");
  if (progress >= VINE_WARP_TARGET_PROGRESS || sample.vineVisible || sample.warpZoneVisible) goals.add("post-target-frontier");
  if (progress >= 1280) goals.add("deep-frontier");

  if (sample.yOnScreen >= 160) goals.add("lower-route");
  if (sample.yOnScreen <= 148 && progress >= 160) goals.add("upper-block-route");
  if (sample.yOnScreen <= 128) goals.add("high-route");

  if (sample.hiddenBlockTileCount > 0) goals.add("hidden-blocks");
  if (sample.vineVisible || sample.vineTileCount > 0 || sample.onVine) goals.add("hidden-vine");
  if (sample.warpZoneVisible || sample.warpZoneControl > 1) goals.add("warp-zone");
  if (sample.enteringPipe || sample.changeAreaTimer > 0) goals.add("warp-pipe");
  if ((sample.areaMusic & 0x04) !== 0 && sample.areaOffset !== 0) goals.add("coin-room");
  if (sample.pipeInteraction || sample.pipeTileCount > 0) goals.add("pipe-hotspot");
  if (
    sample.pipeInteraction &&
    (sample.scrollLock > 0 || sample.playerCollisionBits !== 0xff || sample.playerHitDetectFlag !== 0)
  ) {
    goals.add("wall-clip-hotspot");
  }
  if (sample.enemyTypes.some((type) => type > 0)) goals.add("enemy-encounter");
  if (sample.enemyTypes.some((type) => type >= 0x24 && type <= 0x2c)) goals.add("moving-lifts");

  return goals;
}

export function summarizeWorld42CoverageGoals(goals: Iterable<string>): CoverageGoalSummary {
  const coveredGoals = new Set(goals);
  const requiredGoals = [...WORLD_4_2_REQUIRED_COVERAGE_GOALS];
  const covered = requiredGoals.filter((goal) => coveredGoals.has(goal));
  const missing = requiredGoals.filter((goal) => !coveredGoals.has(goal));
  const percent = requiredGoals.length === 0 ? 100 : Number(((covered.length / requiredGoals.length) * 100).toFixed(1));

  return {
    target: WORLD_4_2_COVERAGE_TARGET,
    required: requiredGoals.length,
    covered: covered.length,
    percent,
    complete: missing.length === 0,
    missing
  };
}

export function scoreCoverageGoals(goalsHit: Iterable<string>, alreadyCovered: Iterable<string> = []): number {
  const goals = new Set(goalsHit);
  const covered = new Set(alreadyCovered);
  let score = 0;

  for (const goal of goals) {
    const isRequired = (WORLD_4_2_REQUIRED_COVERAGE_GOALS as readonly string[]).includes(goal);
    const newGoal = !covered.has(goal);
    score += newGoal ? 48 : 6;
    if (isRequired) {
      score += newGoal ? 18 : 2;
    }
    if (goal === "hidden-vine" || goal === "warp-zone" || goal === "coin-room" || goal === "upper-block-route") {
      score += newGoal ? 18 : 4;
    }
  }

  return Number(score.toFixed(2));
}

export interface DiscoveryScoreContext {
  startProgress?: number;
  targetReached?: boolean;
  coverageScore?: number;
  routeScore?: number;
  speedScore?: number;
  roomScore?: number;
  gameScore?: number;
}

export function scoreDiscoveryEpisode(
  session: Pick<SessionResult, "metrics" | "coverage" | "findings">,
  cells: Set<string>,
  newCells: number,
  bugScore = scoreFindings(session.findings),
  context: DiscoveryScoreContext = {}
): number {
  const componentScores = {
    coverageScore: context.coverageScore ?? 0,
    routeScore: context.routeScore ?? 0,
    speedScore: context.speedScore ?? 0,
    roomScore: context.roomScore ?? 0,
    gameScore: context.gameScore ?? 0,
    progressScore: scoreDiscoveryProgress(session, cells, newCells, context)
  };
  const rawScore =
    bugScore +
    componentScores.coverageScore +
    componentScores.routeScore +
    componentScores.speedScore +
    componentScores.roomScore +
    componentScores.gameScore +
    componentScores.progressScore;

  return Number(adjustDiscoveryScoreForDeath(rawScore, session, bugScore, componentScores).toFixed(2));
}

export function scoreDiscoveryProgress(
  session: Pick<SessionResult, "metrics" | "coverage" | "findings">,
  cells: Set<string>,
  newCells: number,
  context: DiscoveryScoreContext = {}
): number {
  const progressDelta = Math.max(0, session.metrics.maxProgress - (context.startProgress ?? 0));
  const reachedTarget = context.targetReached ?? session.metrics.maxProgress >= VINE_WARP_TARGET_PROGRESS;
  const endedDead = session.metrics.deaths > 0;
  const meaningfulBug = hasMeaningfulBugEvidence(session.findings, scoreFindings(session.findings));
  const diedBeforeTarget = !reachedTarget && session.metrics.deaths > 0;
  const routeValueMultiplier = endedDead ? (meaningfulBug ? 0.55 : 0.28) : diedBeforeTarget ? 0.32 : 1;
  const earlyDeathPenalty = endedDead
    ? session.metrics.deaths * (session.metrics.maxProgress < 320 ? 360 : meaningfulBug ? 140 : 260)
    : 0;
  const preTargetDeathPenalty = diedBeforeTarget ? 220 : 0;
  const transitionLoopPenalty = session.findings.some((finding) => finding.type === "transition-loop") && newCells === 0 ? 45 : 0;
  const shallowLoopPenalty = session.metrics.maxProgress < 240 ? 35 : 0;

  return Number(
    (
      newCells * 14 * routeValueMultiplier +
      cells.size * 0.75 * routeValueMultiplier +
      session.coverage.length * 4 +
      (session.metrics.maxProgress / 1.9) * routeValueMultiplier +
      (progressDelta / 1.05) * routeValueMultiplier +
      (reachedTarget ? (endedDead ? 60 : 260) : 0) +
      (endedDead ? -180 : 120) -
      preTargetDeathPenalty -
      earlyDeathPenalty -
      transitionLoopPenalty -
      shallowLoopPenalty
    ).toFixed(2)
  );
}

function adjustDiscoveryScoreForDeath(
  rawScore: number,
  session: Pick<SessionResult, "metrics" | "coverage" | "findings">,
  bugScore: number,
  components: {
    coverageScore: number;
    routeScore: number;
    speedScore: number;
    roomScore: number;
    gameScore: number;
    progressScore: number;
  }
): number {
  if (session.metrics.deaths <= 0) {
    return rawScore;
  }

  const meaningfulBug = hasMeaningfulBugEvidence(session.findings, bugScore);
  const nonBugScore = Math.max(0, rawScore - bugScore);
  if (meaningfulBug) {
    return Math.max(
      0,
      Math.min(
        bugScore + nonBugScore * 0.58 - session.metrics.deaths * 140,
        session.metrics.maxProgress * 1.1 + bugScore * 4 + Math.min(400, components.coverageScore) + Math.min(300, components.roomScore)
      )
    );
  }

  return Math.max(
    0,
    Math.min(
      nonBugScore * 0.22 - session.metrics.deaths * 360,
      session.metrics.maxProgress * 0.55 +
        Math.min(160, components.coverageScore) +
        Math.min(60, components.speedScore) +
        Math.min(80, components.roomScore) +
        Math.min(80, components.gameScore)
    )
  );
}

function hasMeaningfulBugEvidence(findings: Finding[], bugScore: number): boolean {
  if (bugScore >= 100) {
    return true;
  }

  return findings.some(
    (finding) =>
      finding.severity === "high" ||
      finding.type === "emulator-error" ||
      finding.type === "impossible-transition" ||
      finding.type === "wrong-warp-candidate"
  );
}

export function scoreFindings(findings: Finding[]): number {
  return findings.reduce((score, finding) => {
    const severityScore = finding.severity === "high" ? 40 : finding.severity === "medium" ? 18 : finding.severity === "low" ? 8 : 3;
    const typeBonus =
      finding.type === "emulator-error"
        ? 50
        : finding.type === "impossible-transition"
          ? 45
          : finding.type === "wrong-warp-candidate"
            ? 25
            : finding.type === "wall-clip-risk"
              ? 20
              : finding.type === "transition-loop"
                ? 18
                : 0;
    return score + severityScore + typeBonus;
  }, 0);
}

export function scoreArchiveSelection(
  entry: Pick<ArchiveEntry, "progress" | "bestProgress" | "visits" | "novelty" | "bugScore" | "depth" | "targetReached"> &
    Partial<Pick<ArchiveEntry, "attempts" | "deaths" | "successes" | "bestSurvivalFrames" | "bestChildProgress">>
): number {
  const progressScore = entry.progress / 18 + entry.bestProgress / 28;
  const noveltyScore = entry.novelty * 24;
  const bugScore = Math.min(80, entry.bugScore);
  const targetScore = entry.targetReached ? 90 : 0;
  const attempts = entry.attempts ?? entry.visits;
  const deaths = entry.deaths ?? 0;
  const successes = entry.successes ?? Math.max(0, attempts - deaths);
  const deathRate = attempts > 0 ? deaths / attempts : 0;
  const reliabilityMultiplier = attempts < 2 ? 1 : clampNumber(1.1 - deathRate * 0.85 + Math.min(0.2, successes * 0.04), 0.18, 1.25);
  const survivalScore = Math.min(42, (entry.bestSurvivalFrames ?? 0) / 75);
  const childProgressScore = Math.max(0, (entry.bestChildProgress ?? entry.bestProgress) - entry.progress) / 18;
  const deathPenalty = deaths >= 2 ? deathRate * 80 : deathRate * 24;
  const visitDivisor = Math.sqrt(entry.visits + 1);
  const weightedScore =
    ((1 + progressScore + noveltyScore + bugScore + targetScore + entry.depth * 2 + survivalScore + childProgressScore - deathPenalty) *
      reliabilityMultiplier) /
    visitDivisor;
  return Number(Math.max(0.001, weightedScore).toFixed(3));
}

export function chooseArchiveEntry(entries: ArchiveEntry[], random: () => number): ArchiveEntry | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const weights = entries.map(scoreArchiveSelection);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = random() * total;

  for (let index = 0; index < entries.length; index += 1) {
    pick -= weights[index] ?? 0;
    if (pick <= 0) {
      return entries[index];
    }
  }

  return entries.at(-1);
}

export function upsertArchiveCheckpoint(
  archive: Map<string, ArchiveEntry>,
  checkpoint: ArchiveCheckpointInput,
  checkpointLimit: number
): boolean {
  const next = checkpointToArchiveEntry(checkpoint);
  const existing = archive.get(checkpoint.cell);

  if (!existing) {
    archive.set(checkpoint.cell, next);
    pruneArchive(archive, checkpointLimit);
    return true;
  }

  if (shouldReplaceArchiveEntry(existing, next)) {
    archive.set(checkpoint.cell, {
      ...next,
      id: existing.id,
      visits: existing.visits,
      attempts: existing.attempts,
      deaths: existing.deaths,
      successes: existing.successes,
      bestSurvivalFrames: Math.max(existing.bestSurvivalFrames, next.bestSurvivalFrames),
      bestChildProgress: Math.max(existing.bestChildProgress, next.bestChildProgress)
    });
    pruneArchive(archive, checkpointLimit);
    return true;
  }

  return false;
}

function createInitialArchiveEntry(inputs: LoadedInputs, controllerConfig: ProgressControllerConfig, workerIndex: number): ArchiveEntry {
  const emulator = new HeadlessNes();
  emulator.load(inputs.romData, cloneJson(inputs.stateData));
  const snapshot = decodeSmbRam(emulator.getCpuMemory());
  const cell = createArchiveCell(snapshot);
  const coverageGoals = [...classifyWorld42CoverageGoals(snapshot)];

  return {
    id: `cell_initial_w${workerIndex}`,
    cell,
    stateData: emulator.snapshot(),
    replayInputs: [],
    frame: 0,
    progress: snapshot.progress,
    bestProgress: snapshot.progress,
    visits: 0,
    attempts: 0,
    deaths: 0,
    successes: 0,
    bestSurvivalFrames: 0,
    bestChildProgress: snapshot.progress,
    novelty: 1,
    bugScore: sampleBugPotential(snapshot),
    coverageGoals,
    score: snapshot.progress / 10,
    depth: 0,
    targetReached: reachedVineWarpTarget(snapshot),
    reason: "initial-state",
    controllerConfig
  };
}

function checkpointToArchiveEntry(checkpoint: ArchiveCheckpointInput): ArchiveEntry {
  return {
    ...checkpoint,
    stateData: cloneJson(checkpoint.stateData),
    replayInputs: checkpoint.replayInputs.map((range) => ({ ...range, buttons: [...range.buttons] })),
    visits: 0,
    attempts: 0,
    deaths: 0,
    successes: 0,
    bestSurvivalFrames: 0,
    bestChildProgress: checkpoint.bestProgress,
    score: scoreArchiveCheckpoint(checkpoint)
  };
}

function scoreArchiveCheckpoint(checkpoint: ArchiveCheckpointInput): number {
  const targetBonus = checkpoint.targetReached ? 140 : 0;
  const reasonBonus = checkpoint.reason.includes("vine") || checkpoint.reason.includes("warp") ? 80 : checkpoint.reason.includes("progress") ? 30 : 10;
  return Number(
    (
      checkpoint.bestProgress / 5 +
      checkpoint.progress / 8 +
      checkpoint.novelty * 25 +
      Math.min(90, checkpoint.bugScore) +
      checkpoint.depth * 3 +
      targetBonus +
      reasonBonus
    ).toFixed(2)
  );
}

function shouldReplaceArchiveEntry(existing: ArchiveEntry, next: ArchiveEntry): boolean {
  if (next.targetReached && !existing.targetReached) {
    return true;
  }

  if (next.bestProgress >= existing.bestProgress + 96) {
    return true;
  }

  return next.score >= existing.score + 20;
}

export function shouldKeepCheckpointAfterEpisode(
  checkpoint: Pick<ArchiveCheckpointInput, "frame" | "targetReached" | "bugScore">,
  deathFrame?: number
): boolean {
  if (deathFrame === undefined) {
    return true;
  }

  if (checkpoint.targetReached || checkpoint.bugScore >= 35) {
    return true;
  }

  return deathFrame - checkpoint.frame >= 90;
}

function pruneArchive(archive: Map<string, ArchiveEntry>, checkpointLimit: number): void {
  if (archive.size <= checkpointLimit) {
    return;
  }

  const protectedCells = new Set<string>();
  for (const goal of WORLD_4_2_REQUIRED_COVERAGE_GOALS) {
    const bestForGoal = [...archive.entries()]
      .filter(([, entry]) => entry.frame > 0 && entry.coverageGoals.includes(goal))
      .sort((a, b) => scoreArchiveSelection(b[1]) - scoreArchiveSelection(a[1]))[0];
    if (bestForGoal) {
      protectedCells.add(bestForGoal[0]);
    }
  }

  const removable = [...archive.entries()]
    .filter(([, entry]) => entry.frame > 0)
    .sort((a, b) => {
      const aProtected = protectedCells.has(a[0]) ? 1 : 0;
      const bProtected = protectedCells.has(b[0]) ? 1 : 0;
      return aProtected - bProtected || scoreArchiveSelection(a[1]) - scoreArchiveSelection(b[1]) || b[1].visits - a[1].visits;
    });

  while (archive.size > checkpointLimit && removable.length > 0) {
    const [cell] = removable.shift()!;
    archive.delete(cell);
  }
}

function chooseDiscoveryParent(
  entries: ArchiveEntry[],
  random: () => number,
  bestProgress: number,
  focus: DiscoveryFocus,
  bugTarget: BugTarget,
  coverageGoal: CoverageGoalSummary = summarizeWorld42CoverageGoals([])
): ArchiveEntry | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  if (focus === "progress") {
    return chooseProgressParent(entries, random, bestProgress);
  }

  const coverageParent = chooseCoverageParent(entries, random, coverageGoal.missing);
  if (focus === "coverage") {
    if (coverageParent && random() < 0.86) {
      return coverageParent;
    }
  } else if (coverageParent && random() < 0.34) {
    return coverageParent;
  }

  const bugParent = chooseBugHotspotEntry(entries, random, bugTarget);
  const bugSelectionRate =
    focus === "bugs" ? 0.82 : focus === "coverage" ? 0.18 : bestProgress >= BUG_PROBE_FRONTIER_PROGRESS ? 0.5 : 0.22;
  if (bugParent && random() < bugSelectionRate) {
    return bugParent;
  }

  return chooseProgressParent(entries, random, bestProgress);
}

function chooseCoverageParent(entries: ArchiveEntry[], random: () => number, missingGoals: string[]): ArchiveEntry | undefined {
  const candidates = entries
    .map((entry) => ({ entry, weight: scoreCoverageParent(entry, missingGoals) }))
    .filter((candidate) => candidate.weight > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let pick = random() * total;
  for (const candidate of candidates) {
    pick -= candidate.weight;
    if (pick <= 0) {
      return candidate.entry;
    }
  }

  return candidates.at(-1)?.entry;
}

export function scoreCoverageParent(
  entry: Pick<ArchiveEntry, "coverageGoals" | "progress" | "visits" | "novelty" | "bestProgress" | "depth" | "bugScore" | "targetReached">,
  missingGoals: Iterable<string>
): number {
  const missing = new Set(missingGoals);
  if (missing.size === 0) {
    return scoreArchiveSelection(entry);
  }

  const goals = entry.coverageGoals ?? [];
  const directHits = goals.filter((goal) => missing.has(goal)).length;
  const progressBucketHits = goals.filter((goal) => goal.startsWith("progress-") && missing.has(goal)).length;
  const screenHits = goals.filter((goal) => goal.startsWith("screen-") && missing.has(goal)).length;
  const routeHits = goals.filter((goal) => !goal.startsWith("progress-") && !goal.startsWith("screen-") && missing.has(goal)).length;
  const visitPenalty = Math.sqrt(entry.visits + 1);
  const frontierBonus = entry.targetReached ? 18 : Math.min(28, entry.bestProgress / 80);
  const score =
    directHits * 90 +
    routeHits * 40 +
    progressBucketHits * 22 +
    screenHits * 18 +
    entry.novelty * 24 +
    frontierBonus +
    entry.depth * 4 +
    Math.min(30, entry.bugScore) +
    Math.min(24, entry.progress / 96);

  return Number(Math.max(0, score / visitPenalty).toFixed(3));
}

function chooseProgressParent(entries: ArchiveEntry[], random: () => number, bestProgress: number): ArchiveEntry | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const viable = entries.filter((entry) => isViableProgressParent(entry, bestProgress));
  const candidates = viable.length > 0 ? viable : entries;

  if (bestProgress < VINE_WARP_TARGET_PROGRESS && random() < 0.86) {
    return [...candidates].sort((a, b) => scoreRouteParent(b, bestProgress) - scoreRouteParent(a, bestProgress))[0];
  }

  return chooseArchiveEntry(candidates, random);
}

function chooseBugHotspotEntry(entries: ArchiveEntry[], random: () => number, bugTarget: BugTarget): ArchiveEntry | undefined {
  const candidates = entries
    .map((entry) => ({ entry, weight: scoreBugHotspot(entry, bugTarget) }))
    .filter((candidate) => candidate.weight > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let pick = random() * total;
  for (const candidate of candidates) {
    pick -= candidate.weight;
    if (pick <= 0) {
      return candidate.entry;
    }
  }

  return candidates.at(-1)?.entry;
}

export function scoreBugHotspot(entry: Pick<ArchiveEntry, "cell" | "reason" | "bugScore" | "progress" | "targetReached" | "visits">, bugTarget: BugTarget = "all"): number {
  const cell = entry.cell.toLowerCase();
  const reason = entry.reason.toLowerCase();
  const warpSignals = Number(cell.includes(".warp.") || cell.includes(".vine.") || reason.includes("warp") || reason.includes("vine") || reason.includes("transition"));
  const wallSignals = Number(cell.includes("pipe.") || reason.includes("pipe") || reason.includes("collision") || entry.bugScore >= 16);

  if (bugTarget === "warp-zone" && warpSignals === 0) {
    return 0;
  }
  if (bugTarget === "wall-clip" && wallSignals === 0) {
    return 0;
  }
  if (bugTarget === "all" && warpSignals === 0 && wallSignals === 0) {
    return 0;
  }

  const targetBonus = entry.targetReached ? 24 : 0;
  const progressBonus = Math.min(55, entry.progress / 16);
  const visitPenalty = Math.sqrt(entry.visits + 1);
  const signalScore = warpSignals * 42 + wallSignals * 36 + Math.min(80, entry.bugScore) + targetBonus + progressBonus;
  return Number(Math.max(0, signalScore / visitPenalty).toFixed(3));
}

function chooseGoExploreControlMode(
  parent: ArchiveEntry,
  random: () => number,
  bestProgress: number,
  focus: DiscoveryFocus,
  bugTarget: BugTarget
): GoExploreControlMode {
  const warpScore = scoreBugHotspot(parent, "warp-zone");
  const wallScore = scoreBugHotspot(parent, "wall-clip");
  const canProbe = focus !== "progress" && (warpScore > 0 || wallScore > 0);
  if (focus !== "progress" && bugTarget === "wall-clip") {
    if (wallScore > 0) {
      const trickRate = focus === "bugs" ? 0.86 : bestProgress >= BUG_PROBE_FRONTIER_PROGRESS ? 0.62 : 0.38;
      if (random() < trickRate) {
        return "wall-clip-trick";
      }
    }

    if (focus === "bugs" && random() < 0.36) {
      return "wall-clip-trick";
    }
  }

  if (canProbe) {
    const probeRate = focus === "bugs" ? 0.78 : bestProgress >= BUG_PROBE_FRONTIER_PROGRESS ? 0.48 : 0.22;
    if (random() < probeRate) {
      if (bugTarget === "warp-zone") return "warp-zone-probe";
      if (bugTarget === "wall-clip") return "wall-clip-probe";
      if (warpScore === 0) return "wall-clip-probe";
      if (wallScore === 0) return "warp-zone-probe";
      if (random() < warpScore / (warpScore + wallScore)) {
        return "warp-zone-probe";
      }
      return random() < 0.55 ? "wall-clip-trick" : "wall-clip-probe";
    }
  }

  if (focus === "coverage") {
    return random() < 0.76 ? "coverage-explore" : "action-fuzz";
  }

  if (focus === "balanced" && random() < 0.28) {
    return "coverage-explore";
  }

  if (bestProgress >= VINE_WARP_TARGET_PROGRESS) {
    return random() < 0.72 ? "action-fuzz" : "route-seed";
  }

  const attempts = Math.max(1, parent.attempts);
  const deathRate = parent.deaths / attempts;
  if (parent.progress < 384 || deathRate > 0.35) {
    return random() < 0.78 ? "route-seed" : "action-fuzz";
  }

  return random() < 0.42 ? "route-seed" : "action-fuzz";
}

function formatMutationLabel(mutation: string, controlMode: GoExploreControlMode): string {
  if (controlMode === "wall-clip-trick") {
    return `${mutation}+4-2-wall-clip-trick`;
  }
  if (controlMode === "warp-zone-probe" || controlMode === "wall-clip-probe") {
    return `${mutation}+hotspot-probe`;
  }
  if (controlMode === "coverage-explore") {
    return `${mutation}+coverage-explore`;
  }

  return `${mutation}+${controlMode === "action-fuzz" ? "checkpoint-action-fuzz" : "progress-controller"}`;
}

function updateArchiveParentOutcome(parent: ArchiveEntry, session: SessionResult): void {
  parent.attempts += 1;
  parent.bestSurvivalFrames = Math.max(parent.bestSurvivalFrames, session.metrics.frames);
  parent.bestChildProgress = Math.max(parent.bestChildProgress, session.metrics.maxProgress);
  parent.bestProgress = Math.max(parent.bestProgress, session.metrics.maxProgress);
  parent.score = Math.max(parent.score, session.agent?.score ?? 0, scoreArchiveSelection(parent));

  if (session.metrics.deaths > 0) {
    parent.deaths += 1;
    return;
  }

  parent.successes += 1;
}

function isViableProgressParent(entry: ArchiveEntry, bestProgress: number): boolean {
  if (entry.targetReached || entry.bestProgress >= bestProgress - 96) {
    return true;
  }

  if (entry.attempts < 3) {
    return true;
  }

  const deathRate = entry.deaths / entry.attempts;
  return deathRate < 0.65 || entry.bestChildProgress >= bestProgress - 64;
}

function scoreRouteParent(entry: ArchiveEntry, bestProgress: number): number {
  const attempts = Math.max(1, entry.attempts);
  const deathRate = entry.deaths / attempts;
  const successRate = entry.successes / attempts;
  const bestRouteProgress = Math.max(entry.bestProgress, entry.bestChildProgress);
  const frontierBonus = bestRouteProgress >= bestProgress - 64 ? 120 : 0;
  const underexploredBonus = entry.attempts < 3 ? 25 : 0;
  const survivalBonus = Math.min(60, entry.bestSurvivalFrames / 60);
  const deathPenalty = entry.deaths >= 2 ? deathRate * 180 : deathRate * 60;

  return (
    bestRouteProgress * 1.25 +
    entry.progress * 0.55 +
    entry.depth * 10 +
    entry.novelty * 20 +
    successRate * 70 +
    frontierBonus +
    underexploredBonus +
    survivalBonus -
    entry.visits * 4 -
    deathPenalty
  );
}

function createProgressMutation(
  parent: ProgressControllerConfig,
  random: () => number,
  parentProgress: number,
  bestProgress: number
): { config: ProgressControllerConfig; mutation: string } {
  if (bestProgress < VINE_WARP_TARGET_PROGRESS && random() < 0.45) {
    return {
      config: progressBiasedConfig(createBaselineProgressControllerConfig(randomInteger(random, 1, 999999))),
      mutation: "fresh-progress-controller"
    };
  }

  return mutateProgressControllerConfig(parent, random, parentProgress, bestProgress);
}

function progressBiasedConfig(config: ProgressControllerConfig): ProgressControllerConfig {
  return {
    ...config,
    stuckFrames: Math.min(config.stuckFrames, 48),
    recoveryFrames: Math.max(config.recoveryFrames, 34),
    pipeHoldFrames: 0,
    exploratoryLeftEvery: 0,
    exploratoryLeftFrames: 0
  };
}

function checkpointReason(
  sample: FrameSample,
  previous: FrameSample | undefined,
  parentProgress: number,
  seenCheckpointKeys: Set<string>
): string | undefined {
  if (sample.dying) {
    return undefined;
  }

  const active = isControllableCheckpoint(sample);
  const cell = createArchiveCell(sample);
  const progressBucket = Math.floor(sample.progress / 96);
  const key = `${cell}|b${progressBucket}`;
  if (seenCheckpointKeys.has(key)) {
    return undefined;
  }

  if (!active) {
    return undefined;
  }

  const special =
    sample.vineVisible
      ? "vine-visible"
      : sample.warpZoneVisible
        ? "warp-zone-visible"
        : sample.enteringPipe || sample.changeAreaTimer > 0
        ? "transition-or-pipe-entry"
        : sample.hiddenBlockTileCount > 0
          ? "hidden-blocks"
          : sample.playerCollisionBits !== 0xff || sample.playerHitDetectFlag !== 0 || sample.enemyCollisionBits !== 0
            ? "collision-pressure"
            : sample.scrollLock > 0
              ? "scroll-lock"
              : sample.pipeInteraction
              ? "pipe-adjacent"
              : undefined;
  const progressJump = previous ? sample.progress - previous.progress >= 96 : false;
  const deeper = sample.progress >= parentProgress + 64;

  if (sample.progress > 64 && previous?.levelLoading !== 0) {
    seenCheckpointKeys.add(key);
    return "active-post-transition";
  }

  if (special) {
    seenCheckpointKeys.add(key);
    return special;
  }

  if (deeper || progressJump || !previous) {
    seenCheckpointKeys.add(key);
    return progressJump ? "progress-jump" : "progress-bucket";
  }

  return undefined;
}

function scoreCheckpointCaptureCandidate(sample: FrameSample, reason: string, parentProgress: number): number {
  const targetBonus = reachedVineWarpTarget(sample) ? 1000 : 0;
  const depthBonus = Math.max(0, sample.progress - parentProgress) * 3;
  const progressBonus = sample.progress;
  const bugBonus = sampleBugPotential(sample) * 6;
  const reasonBonus =
    reason.includes("vine") || reason.includes("warp")
      ? 700
      : reason.includes("pipe") || reason.includes("collision") || reason.includes("hidden")
        ? 420
        : reason.includes("transition")
          ? 240
          : reason.includes("progress")
            ? 160
            : 60;

  return targetBonus + depthBonus + progressBonus + bugBonus + reasonBonus;
}

function checkpointReplacementIndex(checkpoints: CapturedCheckpoint[], priority: number, budget: number): number | undefined {
  if (budget <= 0) {
    return undefined;
  }

  if (checkpoints.length < budget) {
    return checkpoints.length;
  }

  let lowestIndex = 0;
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (checkpoints[index]!.priority < checkpoints[lowestIndex]!.priority) {
      lowestIndex = index;
    }
  }

  return priority > checkpoints[lowestIndex]!.priority ? lowestIndex : undefined;
}

function isControllableCheckpoint(sample: Pick<FrameSample, "gameMode" | "playerStateName">): boolean {
  return sample.gameMode === 1 && (sample.playerStateName === "normal" || sample.playerStateName === "climbing-vine");
}

function isWorld42SubArea(sample: Pick<SmbRamSnapshot, "rawWorld" | "rawLevel">): boolean {
  return sample.rawWorld === 3 && sample.rawLevel !== 1;
}

function sampleBugPotential(sample: SmbRamSnapshot): number {
  let score = 0;
  if (sample.vineVisible) score += 12;
  if (sample.warpZoneVisible) score += 18;
  if (sample.enteringPipe || sample.changeAreaTimer > 0) score += 12;
  if (sample.pipeInteraction) score += 6;
  if (sample.hiddenBlockTileCount > 0) score += 8;
  if (sample.scrollLock > 0) score += 10;
  if (sample.playerCollisionBits === 0xfe || sample.playerHitDetectFlag === 0xff) score += 16;
  if (sample.world < 1 || sample.world > 8 || sample.level < 1 || sample.level > 4) score += 50;
  return score;
}

function reachedVineWarpTarget(sample: Pick<SmbRamSnapshot, "progress" | "vineVisible" | "warpZoneVisible">): boolean {
  return sample.progress >= VINE_WARP_TARGET_PROGRESS || sample.vineVisible || sample.warpZoneVisible;
}

function selectTopEpisodes(episodes: DiscoveryEpisode[], top: number, focus: DiscoveryFocus): DiscoveryEpisode[] {
  return selectSavedDiscoveryItems(episodes, (episode) => episode.session, top, focus);
}

export function selectSavedDiscoverySessions(sessions: SessionResult[], top: number, focus: DiscoveryFocus = DEFAULT_DISCOVERY_FOCUS): SessionResult[] {
  return selectSavedDiscoveryItems(sessions, (session) => session, top, focus);
}

function selectSavedDiscoveryItems<T>(items: T[], sessionOf: (item: T) => SessionResult, top: number, focus: DiscoveryFocus): T[] {
  if (focus === "progress") {
    return [...items].sort((a, b) => compareProgressSessions(sessionOf(a), sessionOf(b))).slice(0, top);
  }

  if (focus === "coverage") {
    return selectCoverageDiverseItems(items, sessionOf, top);
  }

  if (focus === "bugs") {
    return fillUniqueItems(
      [...items].sort((a, b) => compareBugSessions(sessionOf(a), sessionOf(b))),
      [...items].sort((a, b) => compareProgressSessions(sessionOf(a), sessionOf(b))),
      top
    );
  }

  const bugQuota = Math.max(1, Math.floor(top / 2));
  const bugItems = [...items]
    .filter((item) => isBugCandidate(sessionOf(item)))
    .sort((a, b) => compareBugSessions(sessionOf(a), sessionOf(b)))
    .slice(0, bugQuota);
  const coverageQuota = Math.max(1, Math.floor(top / 3));
  const coverageItems = selectCoverageDiverseItems(items, sessionOf, coverageQuota);
  const progressItems = [...items].sort((a, b) => compareProgressSessions(sessionOf(a), sessionOf(b)));
  const progressQuota = Math.max(1, Math.ceil(top / 2));
  const primaryProgressItems = progressItems.slice(0, progressQuota);
  const bugPhaseItems = [...items]
    .filter((item) => sessionOf(item).agent?.phase === "go-explore-bug")
    .sort((a, b) => compareBugSessions(sessionOf(a), sessionOf(b)))
    .slice(0, Math.max(1, Math.floor(top / 4)));
  const balancedItems = [...items].sort((a, b) => compareBalancedSessions(sessionOf(a), sessionOf(b)));

  return fillUniqueItems(primaryProgressItems, bugPhaseItems, top, bugItems, coverageItems, progressItems, balancedItems).sort((a, b) =>
    compareBalancedSessions(sessionOf(a), sessionOf(b))
  );
}

function fillUniqueItems<T>(primary: T[], secondary: T[], top: number, ...additional: T[][]): T[] {
  const selected: T[] = [];
  for (const item of [...primary, ...secondary, ...additional.flat()]) {
    if (selected.includes(item)) {
      continue;
    }
    selected.push(item);
    if (selected.length >= top) {
      break;
    }
  }
  return selected;
}

function selectCoverageDiverseItems<T>(items: T[], sessionOf: (item: T) => SessionResult, top: number): T[] {
  const selected: T[] = [];
  const bestByGoal = new Map<string, T>();

  for (const item of items) {
    const session = sessionOf(item);
    for (const goal of session.agent?.coverageGoalsHit ?? []) {
      const existing = bestByGoal.get(goal);
      if (!existing || compareCoverageSessions(session, sessionOf(existing)) < 0) {
        bestByGoal.set(goal, item);
      }
    }
  }

  const goalRepresentatives: T[] = [];
  for (const goal of WORLD_4_2_REQUIRED_COVERAGE_GOALS) {
    const item = bestByGoal.get(goal);
    if (item && !goalRepresentatives.includes(item)) {
      goalRepresentatives.push(item);
    }
  }
  goalRepresentatives.sort((a, b) => compareCoverageSessions(sessionOf(a), sessionOf(b)));
  const bugItems = [...items].filter((item) => isBugCandidate(sessionOf(item))).sort((a, b) => compareBugSessions(sessionOf(a), sessionOf(b)));
  const progressItems = [...items].sort((a, b) => compareProgressSessions(sessionOf(a), sessionOf(b)));

  for (const item of [...goalRepresentatives, ...bugItems, ...progressItems]) {
    if (selected.includes(item)) {
      continue;
    }
    selected.push(item);
    if (selected.length >= top) {
      break;
    }
  }

  return selected.sort((a, b) => compareCoverageSessions(sessionOf(a), sessionOf(b)));
}

function compareBalancedSessions(a: SessionResult, b: SessionResult): number {
  const aHighBug = a.findings.some((finding) => finding.severity === "high") ? 1 : 0;
  const bHighBug = b.findings.some((finding) => finding.severity === "high") ? 1 : 0;
  const aSurvived = a.metrics.deaths === 0 ? 1 : 0;
  const bSurvived = b.metrics.deaths === 0 ? 1 : 0;
  return (
    Number(b.agent?.targetReached ?? false) - Number(a.agent?.targetReached ?? false) ||
    Number(isBugCandidate(b)) - Number(isBugCandidate(a)) ||
    bSurvived - aSurvived ||
    (b.agent?.routeScore ?? 0) - (a.agent?.routeScore ?? 0) ||
    (b.agent?.speedScore ?? 0) - (a.agent?.speedScore ?? 0) ||
    b.metrics.maxProgress - a.metrics.maxProgress ||
    (b.agent?.gameScoreDelta ?? 0) - (a.agent?.gameScoreDelta ?? 0) ||
    (b.agent?.coverageScore ?? 0) - (a.agent?.coverageScore ?? 0) ||
    (b.agent?.score ?? 0) - (a.agent?.score ?? 0) ||
    bHighBug - aHighBug ||
    (b.agent?.newCells ?? 0) - (a.agent?.newCells ?? 0)
  );
}

function compareCoverageSessions(a: SessionResult, b: SessionResult): number {
  const aGoals = new Set(a.agent?.coverageGoalsHit ?? []);
  const bGoals = new Set(b.agent?.coverageGoalsHit ?? []);
  const aRouteGoals = [...aGoals].filter((goal) => !goal.startsWith("progress-") && !goal.startsWith("screen-")).length;
  const bRouteGoals = [...bGoals].filter((goal) => !goal.startsWith("progress-") && !goal.startsWith("screen-")).length;
  const aSurvived = a.metrics.deaths === 0 ? 1 : 0;
  const bSurvived = b.metrics.deaths === 0 ? 1 : 0;
  return (
    bRouteGoals - aRouteGoals ||
    bGoals.size - aGoals.size ||
    (b.agent?.coverageScore ?? 0) - (a.agent?.coverageScore ?? 0) ||
    Number(b.agent?.targetReached ?? false) - Number(a.agent?.targetReached ?? false) ||
    bSurvived - aSurvived ||
    b.metrics.maxProgress - a.metrics.maxProgress ||
    (b.agent?.score ?? 0) - (a.agent?.score ?? 0)
  );
}

function compareProgressSessions(a: SessionResult, b: SessionResult): number {
  const aSurvived = a.metrics.deaths === 0 ? 1 : 0;
  const bSurvived = b.metrics.deaths === 0 ? 1 : 0;
  return (
    Number(b.agent?.targetReached ?? false) - Number(a.agent?.targetReached ?? false) ||
    bSurvived - aSurvived ||
    (b.agent?.routeScore ?? 0) - (a.agent?.routeScore ?? 0) ||
    (b.agent?.speedScore ?? 0) - (a.agent?.speedScore ?? 0) ||
    b.metrics.maxProgress - a.metrics.maxProgress ||
    (b.agent?.progressScore ?? 0) - (a.agent?.progressScore ?? 0) ||
    (b.agent?.gameScoreDelta ?? 0) - (a.agent?.gameScoreDelta ?? 0) ||
    (b.agent?.score ?? 0) - (a.agent?.score ?? 0)
  );
}

function compareBugSessions(a: SessionResult, b: SessionResult): number {
  return (
    bugConfidenceScore(b) - bugConfidenceScore(a) ||
    (b.agent?.bugScore ?? 0) - (a.agent?.bugScore ?? 0) ||
    b.findings.length - a.findings.length ||
    Number(b.agent?.targetReached ?? false) - Number(a.agent?.targetReached ?? false) ||
    b.metrics.maxProgress - a.metrics.maxProgress ||
    (b.agent?.score ?? 0) - (a.agent?.score ?? 0)
  );
}

function isBugCandidate(session: SessionResult): boolean {
  return bugConfidenceScore(session) > 0 || (session.agent?.bugScore ?? 0) >= 25 || session.findings.length > 0;
}

function bugConfidenceScore(session: SessionResult): number {
  return session.findings.reduce((score, finding) => {
    const severity = finding.severity === "high" ? 100 : finding.severity === "medium" ? 45 : finding.severity === "low" ? 18 : 8;
    const type =
      finding.type === "wrong-warp-candidate"
        ? 45
        : finding.type === "wall-clip-risk"
          ? 38
          : finding.type === "impossible-transition"
            ? 70
            : finding.type === "transition-loop"
              ? 28
              : 0;
    return score + severity + type;
  }, 0);
}

function reactiveDiscoveryButtons(snapshot: SmbRamSnapshot): ButtonName[] | undefined {
  if (snapshot.dying) {
    return [];
  }

  if (snapshot.onVine) {
    return ["UP", "RIGHT"];
  }

  return undefined;
}

function buttonsForMacro(action: MacroActionName, frame: number): ButtonName[] {
  if (action === "oscillate") {
    return Math.floor(frame / 16) % 2 === 0 ? ["B", "LEFT"] : ["B", "RIGHT"];
  }

  return [...BUTTONS_BY_ACTION[action]];
}

function normalizeTraceDuration(trace: MacroStep[], durationFrames: number): MacroStep[] {
  return normalizeTraceDurationWithFiller(trace, durationFrames, "idle");
}

function normalizeTraceDurationWithFiller(trace: MacroStep[], durationFrames: number, fillerAction: MacroActionName): MacroStep[] {
  const normalized: MacroStep[] = [];
  let remaining = durationFrames;

  for (const step of trace) {
    if (remaining <= 0) {
      break;
    }
    const frames = Math.min(Math.max(1, Math.floor(step.frames)), remaining);
    normalized.push({
      action: step.action,
      frames
    });
    remaining -= frames;
  }

  if (remaining > 0) {
    normalized.push({ action: fillerAction, frames: remaining });
  }

  return normalized;
}

function weightedAction(random: () => number): MacroActionName {
  const roll = random();
  if (roll < 0.28) return "right-b";
  if (roll < 0.48) return "jump-right";
  if (roll < 0.62) return "down-right";
  if (roll < 0.74) return "oscillate";
  if (roll < 0.84) return "left";
  if (roll < 0.92) return "pipe-hold";
  if (roll < 0.97) return "short-hop-left";
  return "idle";
}

function weightedFullRunAction(random: () => number, allowExploration: boolean): MacroActionName {
  const roll = random();
  if (roll < 0.5) return "right-b";
  if (roll < 0.82) return "jump-right";
  if (roll < 0.91) return "pipe-hold";
  if (roll < 0.97) return "down-right";
  if (!allowExploration) return "right-b";
  if (roll < 0.985) return "oscillate";
  if (roll < 0.995) return "short-hop-left";
  return "idle";
}

function macroActionForButtons(buttons: ButtonName[]): MacroActionName {
  const set = new Set(buttons);
  if (set.has("UP") && set.has("RIGHT")) return "climb-right";
  if (set.has("DOWN") && set.has("RIGHT") && set.has("B")) return "pipe-hold";
  if (set.has("DOWN") && set.has("RIGHT")) return "down-right";
  if (set.has("A") && set.has("RIGHT")) return "jump-right";
  if (set.has("RIGHT")) return "right-b";
  if (set.has("A") && set.has("LEFT")) return "short-hop-left";
  if (set.has("LEFT")) return "left";
  return "idle";
}

function mergeAdjacentMacroSteps(trace: MacroStep[]): MacroStep[] {
  const merged: MacroStep[] = [];
  for (const step of trace) {
    const previous = merged.at(-1);
    if (previous && previous.action === step.action) {
      previous.frames += step.frames;
    } else {
      merged.push({ ...step });
    }
  }
  return merged;
}

function chooseParent(corpus: DiscoveryEpisode[], random: () => number): DiscoveryEpisode | undefined {
  if (corpus.length === 0 || random() < 0.2) {
    return undefined;
  }

  const topWindow = Math.min(corpus.length, 10);
  return corpus[randomInteger(random, 0, topWindow - 1)];
}

export function chooseFullRunEvolutionParent(corpus: DiscoveryEpisode[], random: () => number): DiscoveryEpisode | undefined {
  if (corpus.length === 0 || random() < 0.12) {
    return undefined;
  }

  const elites = selectFullRunElites(corpus);
  const pool = elites.length > 0 && random() < 0.72 ? elites : corpus;
  const ranked = [...pool].sort((a, b) => scoreFullRunParent(b) - scoreFullRunParent(a));
  const window = ranked.slice(0, Math.min(ranked.length, 12));
  const total = window.reduce((sum, episode) => sum + scoreFullRunParent(episode), 0);
  let pick = random() * total;
  for (const episode of window) {
    pick -= scoreFullRunParent(episode);
    if (pick <= 0) {
      return episode;
    }
  }

  return window.at(-1);
}

export function mutateFullRunTrace(
  parent: MacroStep[],
  parentSession: SessionResult,
  random: () => number,
  durationFrames: number,
  options: { allowExploration?: boolean } = {}
): { trace: MacroStep[]; mutation: string } {
  const trace = parent.map((step) => ({ ...step }));
  if (trace.length === 0) {
    return generateFreshFullRunTrace(random, durationFrames);
  }

  const obstacleFrame = parentSession.agent?.obstacleFrame;
  if (Number.isFinite(obstacleFrame)) {
    return mutateObstacleApproach(trace, obstacleFrame!, random, durationFrames, options.allowExploration === true);
  }

  const targetFrame = chooseMutationFrame(parentSession, random, durationFrames);
  const targetIndex = traceIndexForFrame(trace, targetFrame);
  const roll = random();
  const allowExploration = options.allowExploration === true;

  if (roll < 0.34) {
    trace[targetIndex] = {
      action: weightedFullRunAction(random, allowExploration),
      frames: Math.max(8, trace[targetIndex]?.frames ?? 36)
    };
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "route-window-replace" };
  }

  if (roll < 0.58) {
    trace.splice(targetIndex, 0, {
      action: weightedFullRunAction(random, allowExploration),
      frames: randomInteger(random, 8, 54)
    });
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "route-window-insert" };
  }

  if (roll < 0.82) {
    const step = trace[targetIndex]!;
    trace[targetIndex] = {
      ...step,
      frames: Math.max(6, step.frames + randomInteger(random, -22, 34))
    };
    return { trace: normalizeTraceDuration(trace, durationFrames), mutation: "route-window-duration-jitter" };
  }

  const prefixFrames = trace.slice(0, targetIndex).reduce(sumFrames, 0);
  const freshTail = generateForwardBiasedMacroTrace(random, Math.max(30, durationFrames - prefixFrames), allowExploration);
  return {
    trace: normalizeTraceDuration([...trace.slice(0, targetIndex), ...freshTail], durationFrames),
    mutation: allowExploration ? "route-window-branch-tail" : "route-window-forward-tail"
  };
}

function chooseMutationFrame(parentSession: SessionResult, random: () => number, durationFrames: number): number {
  const obstacleFrame = parentSession.agent?.obstacleFrame;
  if (Number.isFinite(obstacleFrame)) {
    return clampInteger(obstacleFrame! - randomInteger(random, 45, 180), 1, durationFrames);
  }

  const deathFrame = parentSession.metrics.deaths > 0 ? parentSession.metrics.frames : undefined;
  if (deathFrame !== undefined) {
    return clampInteger(deathFrame - randomInteger(random, 90, 300), 1, durationFrames);
  }

  const findingFrame = parentSession.findings[0]?.frameStart;
  const milestoneFrames = Object.values(parentSession.agent?.milestoneFrames ?? {});
  const latestMilestone = milestoneFrames.length ? Math.max(...milestoneFrames) : undefined;
  const anchor = findingFrame ?? latestMilestone ?? parentSession.metrics.frames;
  const jitter = latestMilestone !== undefined ? randomInteger(random, -90, 210) : randomInteger(random, -180, 90);
  return clampInteger((anchor || durationFrames) + jitter, 1, durationFrames);
}

function mutateObstacleApproach(
  trace: MacroStep[],
  obstacleFrame: number,
  random: () => number,
  durationFrames: number,
  allowExploration: boolean
): { trace: MacroStep[]; mutation: string } {
  const approachStart = clampInteger(obstacleFrame - randomInteger(random, 90, 210), 1, durationFrames);
  const approachEnd = clampInteger(obstacleFrame + randomInteger(random, 24, 96), approachStart, durationFrames);
  const pattern = obstacleJumpPattern(random, allowExploration);
  return {
    trace: replaceTraceWindow(trace, approachStart, approachEnd, pattern.trace, durationFrames),
    mutation: pattern.mutation
  };
}

function obstacleJumpPattern(
  random: () => number,
  allowExploration: boolean
): { trace: MacroStep[]; mutation: string } {
  const roll = random();
  if (roll < 0.26) {
    return {
      mutation: "obstacle-earlier-long-jump",
      trace: [
        { action: "right-b", frames: randomInteger(random, 10, 28) },
        { action: "jump-right", frames: randomInteger(random, 30, 46) },
        { action: "right-b", frames: randomInteger(random, 12, 34) }
      ]
    };
  }

  if (roll < 0.52) {
    return {
      mutation: "obstacle-double-hop",
      trace: [
        { action: "jump-right", frames: randomInteger(random, 14, 24) },
        { action: "right-b", frames: randomInteger(random, 5, 14) },
        { action: "jump-right", frames: randomInteger(random, 20, 34) },
        { action: "right-b", frames: randomInteger(random, 12, 30) }
      ]
    };
  }

  if (roll < 0.76) {
    return {
      mutation: "obstacle-late-release",
      trace: [
        { action: "right-b", frames: randomInteger(random, 20, 44) },
        { action: "jump-right", frames: randomInteger(random, 16, 26) },
        { action: "right-b", frames: randomInteger(random, 28, 58) }
      ]
    };
  }

  if (allowExploration && roll > 0.94) {
    return {
      mutation: "obstacle-micro-reset",
      trace: [
        { action: "right-b", frames: randomInteger(random, 14, 26) },
        { action: "oscillate", frames: randomInteger(random, 8, 14) },
        { action: "jump-right", frames: randomInteger(random, 24, 38) },
        { action: "right-b", frames: randomInteger(random, 10, 28) }
      ]
    };
  }

  return {
    mutation: "obstacle-runup-sweep",
    trace: [
      { action: "right-b", frames: randomInteger(random, 34, 72) },
      { action: "jump-right", frames: randomInteger(random, 22, 42) },
      { action: "right-b", frames: randomInteger(random, 10, 32) }
    ]
  };
}

function replaceTraceWindow(
  trace: MacroStep[],
  frameStart: number,
  frameEnd: number,
  replacement: MacroStep[],
  durationFrames: number
): MacroStep[] {
  const before = sliceTraceByFrame(trace, 1, frameStart - 1);
  const after = sliceTraceByFrame(trace, frameEnd + 1, durationFrames);
  return normalizeTraceDurationWithFiller(mergeAdjacentMacroSteps([...before, ...replacement, ...after]), durationFrames, "right-b");
}

function sliceTraceByFrame(trace: MacroStep[], frameStart: number, frameEnd: number): MacroStep[] {
  if (frameEnd < frameStart) {
    return [];
  }

  const sliced: MacroStep[] = [];
  let cursor = 1;
  for (const step of trace) {
    const stepStart = cursor;
    const stepEnd = cursor + step.frames - 1;
    const overlapStart = Math.max(frameStart, stepStart);
    const overlapEnd = Math.min(frameEnd, stepEnd);
    if (overlapStart <= overlapEnd) {
      sliced.push({ action: step.action, frames: overlapEnd - overlapStart + 1 });
    }
    cursor = stepEnd + 1;
    if (cursor > frameEnd) {
      break;
    }
  }

  return mergeAdjacentMacroSteps(sliced);
}

function traceIndexForFrame(trace: MacroStep[], frame: number): number {
  let cursor = 0;
  for (let index = 0; index < trace.length; index += 1) {
    cursor += trace[index]?.frames ?? 0;
    if (frame <= cursor) {
      return index;
    }
  }
  return Math.max(0, trace.length - 1);
}

function selectFullRunElites(corpus: DiscoveryEpisode[]): DiscoveryEpisode[] {
  return fillUniqueItems(
    [...corpus].sort((a, b) => b.routeScore - a.routeScore),
    [...corpus].sort((a, b) => b.session.metrics.maxProgress - a.session.metrics.maxProgress),
    24,
    [...corpus].sort((a, b) => b.speedScore - a.speedScore),
    [...corpus].sort((a, b) => b.gameScoreDelta - a.gameScoreDelta),
    [...corpus].sort((a, b) => b.roomScore - a.roomScore),
    [...corpus].sort((a, b) => b.coverageScore - a.coverageScore),
    [...corpus].sort((a, b) => b.bugScore - a.bugScore),
    [...corpus].sort((a, b) => b.score - a.score)
  );
}

function scoreFullRunParent(episode: DiscoveryEpisode): number {
  const survived = episode.session.metrics.deaths === 0 ? 220 : -220;
  const target = episode.targetReached ? 180 : 0;
  return Math.max(
    1,
    episode.routeScore * 1.85 +
      episode.speedScore * 1.55 +
      target +
      episode.roomScore * 1.2 +
      episode.gameScore * 0.9 +
      episode.coverageScore * 0.45 +
      episode.progressScore * 0.8 +
      episode.bugScore * 0.55 +
      survived -
      episode.session.metrics.deaths * 180
  );
}

function shouldKeepFullRunInCorpus(episode: DiscoveryEpisode): boolean {
  return (
    (episode.session.metrics.deaths === 0 && episode.session.metrics.maxProgress >= 96) ||
    episode.routeScore >= 120 ||
    episode.speedScore > 40 ||
    episode.roomScore > 0 ||
    episode.gameScoreDelta > 0 ||
    episode.coverageScore > 0 ||
    shouldKeepInCorpus(episode)
  );
}

function pruneFullRunCorpus(corpus: DiscoveryEpisode[]): void {
  const elites = selectFullRunElites(corpus);
  corpus.sort((a, b) => scoreFullRunParent(b) - scoreFullRunParent(a));
  const selected = fillUniqueItems(elites, corpus, 80);
  corpus.splice(0, corpus.length, ...selected);
}

function shouldKeepInCorpus(episode: DiscoveryEpisode): boolean {
  return episode.newCells > 0 || episode.bugScore > 0 || episode.score >= 20;
}

function countNewCells(cells: Set<string>, globalCells: Set<string>): number {
  let count = 0;
  for (const cell of cells) {
    if (!globalCells.has(cell)) {
      count += 1;
    }
  }
  return count;
}

function collectCoverageGoals(samples: FrameSample[]): Set<string> {
  const goals = new Set<string>();
  for (const sample of samples) {
    for (const goal of classifyWorld42CoverageGoals(sample)) {
      goals.add(goal);
    }
  }
  return goals;
}

const SPEED_PROGRESS_MILESTONES = [256, 512, VINE_WARP_TARGET_PROGRESS, 1024, 1280, 1536] as const;

export function computeMilestoneFrames(samples: FrameSample[]): Record<string, number> {
  const milestones: Record<string, number> = {};
  for (const sample of samples) {
    for (const progress of SPEED_PROGRESS_MILESTONES) {
      const key = `progress-${progress}`;
      if (milestones[key] === undefined && sample.progress >= progress) {
        milestones[key] = sample.frame;
      }
    }
    if (milestones["coin-room"] === undefined && (sample.areaMusic & 0x04) !== 0 && sample.areaOffset !== 0) {
      milestones["coin-room"] = sample.frame;
    }
    if (milestones["hidden-vine"] === undefined && (sample.vineVisible || sample.onVine)) {
      milestones["hidden-vine"] = sample.frame;
    }
    if (milestones["warp-zone"] === undefined && sample.warpZoneVisible) {
      milestones["warp-zone"] = sample.frame;
    }
  }
  return milestones;
}

export function scoreSpeedMilestones(milestoneFrames: Record<string, number>, deaths = 0): number {
  let score = 0;
  for (const [key, frame] of Object.entries(milestoneFrames)) {
    const targetFrame = key === "coin-room" || key === "hidden-vine" || key === "warp-zone" ? 2400 : 1800;
    const base = key.startsWith("progress-") ? 70 : 95;
    score += Math.max(8, base * (1 - Math.min(frame, targetFrame) / (targetFrame * 1.35)));
  }
  return Number(Math.max(0, score - deaths * 35).toFixed(2));
}

export function scoreRouteEfficiency(samples: FrameSample[], deaths = 0): number {
  if (samples.length === 0) {
    return 0;
  }

  let maxProgress = 0;
  let maxProgressFrame = samples.at(-1)?.frame ?? samples.length;
  let previousProgress = samples[0]?.progress ?? 0;
  let forwardGain = 0;
  let backwardDrop = 0;
  let stallFrames = 0;

  for (const sample of samples) {
    if (sample.dying) {
      break;
    }

    if (sample.progress > maxProgress) {
      maxProgress = sample.progress;
      maxProgressFrame = sample.frame;
    }

    const delta = sample.progress - previousProgress;
    if (delta > 0) {
      forwardGain += delta;
    } else if (delta < 0) {
      backwardDrop += Math.abs(delta);
    } else if (sample.levelLoading === 0 && sample.gameMode === 1) {
      stallFrames += 1;
    }
    previousProgress = sample.progress;
  }

  const progressPerSecond = maxProgress / Math.max(1, maxProgressFrame / 60);
  const survivalBonus = deaths === 0 ? 180 : -260;
  const targetBonus = maxProgress >= VINE_WARP_TARGET_PROGRESS ? 140 : 0;
  const score =
    maxProgress * 0.42 +
    progressPerSecond * 4.2 +
    forwardGain * 0.08 +
    survivalBonus +
    targetBonus -
    backwardDrop * 2.8 -
    stallFrames * 0.12 -
    deaths * 120;

  return Number(Math.max(0, score).toFixed(2));
}

export function detectForwardObstacleWindow(
  samples: FrameSample[],
  replayInputs: ReproInputRange[],
  minimumFrames = 42
): ForwardObstacleWindow | undefined {
  let active:
    | {
        frameStart: number;
        frameEnd: number;
        startProgress: number;
        maxProgress: number;
        blockedSignals: number;
      }
    | undefined;
  let best: ForwardObstacleWindow | undefined;

  const closeActive = () => {
    if (!active) {
      return;
    }
    const durationFrames = active.frameEnd - active.frameStart + 1;
    const progressDelta = active.maxProgress - active.startProgress;
    if (durationFrames >= minimumFrames && progressDelta <= 8 && active.startProgress >= 96) {
      const reason =
        active.blockedSignals >= Math.floor(durationFrames * 0.35)
          ? "forward-input-blocked-by-geometry"
          : "forward-input-no-progress";
      const candidate: ForwardObstacleWindow = {
        frameStart: active.frameStart,
        frameEnd: active.frameEnd,
        mutationFrame: Math.max(active.frameStart, active.frameEnd - Math.floor(durationFrames * 0.35)),
        progress: active.maxProgress,
        durationFrames,
        reason
      };
      const candidateScore = candidate.durationFrames * 2 + candidate.progress + active.blockedSignals * 3;
      const bestScore = best ? best.durationFrames * 2 + best.progress : -1;
      if (!best || candidateScore > bestScore) {
        best = candidate;
      }
    }
    active = undefined;
  };

  for (const sample of samples) {
    if (sample.dying) {
      closeActive();
      break;
    }

    const buttons = buttonsForFrame(replayInputs, sample.frame);
    const pressingForward = buttons.includes("RIGHT") && !buttons.includes("LEFT") && !buttons.includes("DOWN");
    const activeGameplay = sample.gameMode === 1 && sample.levelLoading === 0;
    if (!pressingForward || !activeGameplay || sample.playerStateName.includes("transforming")) {
      closeActive();
      continue;
    }

    if (!active) {
      active = {
        frameStart: sample.frame,
        frameEnd: sample.frame,
        startProgress: sample.progress,
        maxProgress: sample.progress,
        blockedSignals: 0
      };
    }

    if (sample.progress > active.maxProgress + 8) {
      closeActive();
      active = {
        frameStart: sample.frame,
        frameEnd: sample.frame,
        startProgress: sample.progress,
        maxProgress: sample.progress,
        blockedSignals: 0
      };
    }

    active.frameEnd = sample.frame;
    active.maxProgress = Math.max(active.maxProgress, sample.progress);
    if (sample.horizontalSpeedAbs <= 1 || sample.scrollLock > 0 || sample.playerCollisionBits !== 0xff || sample.playerHitDetectFlag !== 0) {
      active.blockedSignals += 1;
    }
  }

  closeActive();
  return best;
}

export function computeRoomStats(samples: FrameSample[]): { rooms: string[]; transitions: number } {
  const rooms: string[] = [];
  let previous: string | undefined;
  for (const sample of samples) {
    if (sample.dying) {
      break;
    }
    if (sample.roomId !== previous) {
      rooms.push(sample.roomId);
      previous = sample.roomId;
    }
  }
  return {
    rooms,
    transitions: Math.max(0, rooms.length - 1)
  };
}

export function scoreRooms(stats: { rooms: string[]; transitions: number }): number {
  return Number((stats.rooms.length * 24 + stats.transitions * 36).toFixed(2));
}

export function computeGameScoreStats(samples: FrameSample[]): { start: number; final: number; delta: number } {
  const first = samples[0]?.score ?? 0;
  const final = samples.reduce((best, sample) => Math.max(best, sample.score), first);
  return {
    start: first,
    final,
    delta: Math.max(0, final - first)
  };
}

export function scoreGameScoreDelta(delta: number): number {
  return Number(Math.min(220, delta / 12).toFixed(2));
}

function randomInteger(random: () => number, min: number, max: number): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(random() * (high - low + 1)) + low;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distributeEpisodes(episodes: number, workers: number): number[] {
  const base = Math.floor(episodes / workers);
  const remainder = episodes % workers;
  return Array.from({ length: workers }, (_, index) => base + (index < remainder ? 1 : 0)).filter((count) => count > 0);
}

function getDiscoveryWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./discovery-worker.ts" : "./discovery-worker.js", import.meta.url);
}

function getDiscoveryWorkerExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function sameButtons(a: ButtonName[], b: ButtonName[]): boolean {
  return a.length === b.length && a.every((button, index) => button === b[index]);
}

function sumFrames(total: number, step: MacroStep): number {
  return total + step.frames;
}

async function loadInputs(romPath: string, statePath: string): Promise<LoadedInputs> {
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

function normalizeDiscoveryOptions(options: DiscoverOptions): NormalizedDiscoveryOptions {
  const episodes = normalizePositiveInteger(options.episodes, "episodes");
  const episodeDurationSeconds = normalizePositiveInteger(options.episodeDurationSeconds, "episode duration");
  const top = normalizePositiveInteger(options.top, "top");
  const seed = normalizeInteger(options.seed, "seed");
  const strategy = normalizeStrategy(options.strategy ?? DEFAULT_DISCOVERY_STRATEGY);
  const focus = normalizeFocus(options.focus ?? DEFAULT_DISCOVERY_FOCUS);
  const bugTarget = normalizeBugTarget(options.bugTarget ?? DEFAULT_BUG_TARGET);
  const requestedCheckpointLimit = normalizePositiveInteger(options.checkpointLimit ?? DEFAULT_CHECKPOINT_LIMIT, "checkpoint limit");
  const checkpointLimit = Math.min(requestedCheckpointLimit, MAX_EFFECTIVE_CHECKPOINT_LIMIT);
  const workers = Math.min(normalizePositiveInteger(options.workers ?? 1, "workers"), episodes);
  const saveAll = options.saveAll === true || options.episodeLogPath !== undefined;
  const episodeLogPath = saveAll ? resolveEpisodeLogPath(options.outPath, options.episodeLogPath) : undefined;

  if (saveAll && !episodeLogPath) {
    throw new Error("Use --out or --episode-log with --save-all so discovery has a sidecar path for all episode replays.");
  }

  return {
    ...options,
    episodes,
    episodeDurationSeconds,
    top,
    seed,
    strategy,
    focus,
    bugTarget,
    checkpointLimit,
    routeSeed: options.routeSeed ?? true,
    saveAll,
    episodeLogPath,
    workers
  };
}

function normalizeStrategy(value: string): DiscoveryStrategy {
  if (value !== "rl-go-explore" && value !== "full-run-evolution" && value !== "go-explore" && value !== "trace-mutation") {
    throw new Error(`strategy must be one of: rl-go-explore, full-run-evolution, go-explore, trace-mutation. Received ${value}.`);
  }

  return value;
}

function normalizeFocus(value: string): DiscoveryFocus {
  if (value !== "balanced" && value !== "bugs" && value !== "progress" && value !== "coverage") {
    throw new Error(`focus must be one of: balanced, bugs, progress, coverage. Received ${value}.`);
  }

  return value;
}

function normalizeBugTarget(value: string): BugTarget {
  if (value !== "all" && value !== "warp-zone" && value !== "wall-clip") {
    throw new Error(`bug target must be one of: all, warp-zone, wall-clip. Received ${value}.`);
  }

  return value;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
