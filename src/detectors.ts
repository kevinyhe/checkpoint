import { sliceInputRanges } from "./input.js";
import type {
  Finding,
  FindingType,
  FrameSample,
  Persona,
  ReproInputRange,
  SessionMetrics,
  SessionResult,
  SessionStatus,
  Severity
} from "./types.js";

interface StallWindow {
  frameStart: number;
  frameEnd: number;
  progress: number;
  frameHash: string;
}

export function analyzeSession(
  persona: Persona,
  samples: FrameSample[],
  inputRanges: ReproInputRange[],
  extraFindings: Finding[] = []
): SessionResult {
  const gameplaySamples = samplesUntilFirstDeath(samples);
  const metrics = computeMetrics(samples);
  const coverage = computeCoverage(samples);
  const stallWindows = findStallWindows(gameplaySamples);
  const findings = [
    detectWrongWarpCandidate(gameplaySamples, inputRanges),
    detectWallClipRisk(gameplaySamples, inputRanges),
    detectHiddenVine(gameplaySamples, inputRanges),
    ...stallWindows.map((window) => softStallFinding(window, inputRanges)),
    detectDeathLoop(samples, metrics, inputRanges),
    detectRouteBlocked(gameplaySamples, metrics, inputRanges),
    detectImpossibleTransition(gameplaySamples, inputRanges),
    detectTransitionLoop(gameplaySamples, metrics, inputRanges),
    ...extraFindings
  ]
    .filter((finding): finding is Finding => finding !== undefined)
    .sort((a, b) => a.frameStart - b.frameStart || severityRank(b.severity) - severityRank(a.severity));

  return {
    persona,
    status: classifyStatus(metrics, findings),
    metrics: {
      ...metrics,
      stalls: stallWindows.length
    },
    coverage,
    findings,
    replayInputs: inputRanges.map((range) => ({
      frameStart: range.frameStart,
      frameEnd: range.frameEnd,
      buttons: [...range.buttons]
    }))
  };
}

export function computeMetrics(samples: FrameSample[]): SessionMetrics {
  let deaths = 0;
  let transitions = 0;
  let maxProgress = 0;
  let deathStarted = false;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const previous = samples[index - 1];
    if (!deathStarted && !sample.dying) {
      maxProgress = Math.max(maxProgress, sample.progress);
    }

    if (sample.dying && !previous?.dying) {
      deaths += 1;
    }
    if (sample.dying) {
      deathStarted = true;
    }

    if (
      !deathStarted &&
      previous &&
      (sample.world !== previous.world ||
        sample.level !== previous.level ||
        sample.gameMode !== previous.gameMode ||
        sample.levelLoading !== previous.levelLoading ||
        (sample.changeAreaTimer > 0 && previous.changeAreaTimer === 0))
    ) {
      transitions += 1;
    }
  }

  return {
    frames: samples.length,
    gameSeconds: Number((samples.length / 60).toFixed(2)),
    maxProgress,
    deaths,
    stalls: 0,
    transitions
  };
}

export function findStallWindows(samples: FrameSample[], minFrames = 300): StallWindow[] {
  const windows: StallWindow[] = [];
  let start: FrameSample | undefined;
  let last: FrameSample | undefined;

  for (const sample of samples) {
    const canStall = !sample.dying && sample.levelLoading === 0 && sample.gameMode === 1;
    const samePosition = start ? Math.abs(sample.progress - start.progress) <= 2 : false;
    const sameFrame = start ? sample.frameHash === start.frameHash : false;

    if (!start || !canStall || !samePosition || (!sameFrame && sample.horizontalSpeedAbs > 0)) {
      if (start && last && last.frame - start.frame + 1 >= minFrames) {
        windows.push({
          frameStart: start.frame,
          frameEnd: last.frame,
          progress: start.progress,
          frameHash: start.frameHash
        });
      }
      start = canStall ? sample : undefined;
    }

    last = sample;
  }

  if (start && last && last.frame - start.frame + 1 >= minFrames) {
    windows.push({
      frameStart: start.frame,
      frameEnd: last.frame,
      progress: start.progress,
      frameHash: start.frameHash
    });
  }

  return windows;
}

function samplesUntilFirstDeath(samples: FrameSample[]): FrameSample[] {
  const deathIndex = samples.findIndex((sample) => sample.dying);
  if (deathIndex === -1) {
    return samples;
  }

  return samples.slice(0, deathIndex);
}

function detectWrongWarpCandidate(
  samples: FrameSample[],
  inputRanges: ReproInputRange[]
): Finding | undefined {
  const explicitWarp = samples.find((sample) => {
    return sample.warpZoneControl !== 0 && (sample.enteringPipe || sample.changeAreaTimer > 0 || sample.warpZoneVisible);
  });

  const levelChange = samples.find((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || previous.world !== 4 || previous.level !== 2 || (sample.world === 4 && sample.level === 2)) {
      return false;
    }

    if (isExpectedWorld42SubAreaTransition(previous, sample)) {
      return false;
    }

    return isWarpAdjacent(previous) || isWarpAdjacent(sample) || sample.world !== 4 || sample.level < 1 || sample.level > 4;
  });

  const sample = levelChange ?? explicitWarp;
  if (!sample) {
    return undefined;
  }

  const frameStart = Math.max(1, sample.frame - 180);
  const frameEnd = Math.min(samples.at(-1)?.frame ?? sample.frame, sample.frame + 60);
  return createFinding(
    "wrong-warp-candidate",
    levelChange ? "high" : "medium",
    frameStart,
    frameEnd,
    levelChange
      ? `World/level changed from 4-2 to ${sample.world}-${sample.level} during a pipe or warp-adjacent sequence.`
      : `Warp zone control became ${sample.warpZoneControl}, indicating a wrong-warp setup candidate.`,
    {
      world: sample.world,
      level: sample.level,
      rawWorld: sample.rawWorld,
      rawLevel: sample.rawLevel,
      warpZoneControl: sample.warpZoneControl,
      changeAreaTimer: sample.changeAreaTimer,
      enteringPipe: sample.enteringPipe,
      warpZoneVisible: sample.warpZoneVisible,
      progress: sample.progress,
      xOnScreen: sample.xOnScreen,
      yOnScreen: sample.yOnScreen
    },
    inputRanges
  );
}

function detectWallClipRisk(samples: FrameSample[], inputRanges: ReproInputRange[]): Finding | undefined {
  const window = findConsecutive(samples, 18, (sample, index) => {
    if (sample.progress < 64 || (sample.playerStateName !== "normal" && sample.playerStateName !== "climbing-vine")) {
      return false;
    }

    const previous = samples[index - 1];
    const buttons = buttonsAtFrame(inputRanges, sample.frame);
    const pressingIntoGeometry = buttons.includes("RIGHT") || buttons.includes("LEFT") || sample.horizontalSpeedAbs > 0;
    const geometryNearby = sample.pipeInteraction || sample.pipeTileCount > 0 || sample.scrollLock > 0;
    const collisionSignal = sample.playerCollisionBits === 0xfe || sample.playerHitDetectFlag === 0xff || sample.enemyCollisionBits !== 0;
    const lowMovementPressure = geometryNearby && pressingIntoGeometry && sample.horizontalSpeedAbs <= 1 && sample.scrollAmount === 0;
    const abnormalProgress = previous ? pressingIntoGeometry && Math.abs(sample.progress - previous.progress) <= 1 && sample.scrollLock > 0 : false;
    return collisionSignal || lowMovementPressure || abnormalProgress;
  });

  if (!window) {
    return undefined;
  }

  const sample = window.sample;
  return createFinding(
    "wall-clip-risk",
    "medium",
    window.frameStart,
    window.frameEnd,
    "Sustained collision while moving near pipe or wall tiles suggests a possible wall/pipe clipping setup.",
    {
      progress: sample.progress,
      xOnScreen: sample.xOnScreen,
      yOnScreen: sample.yOnScreen,
      playerCollisionBits: sample.playerCollisionBits,
      playerHitDetectFlag: sample.playerHitDetectFlag,
      horizontalSpeedAbs: sample.horizontalSpeedAbs,
      scrollLock: sample.scrollLock,
      scrollAmount: sample.scrollAmount,
      pipeInteraction: sample.pipeInteraction,
      pipeTileCount: sample.pipeTileCount,
      inputPressure: buttonsAtFrame(inputRanges, sample.frame)
    },
    inputRanges
  );
}

function detectHiddenVine(samples: FrameSample[], inputRanges: ReproInputRange[]): Finding | undefined {
  const sample = samples.find((candidate) => candidate.vineVisible);
  if (!sample) {
    return undefined;
  }

  return createFinding(
    "hidden-vine",
    "info",
    Math.max(1, sample.frame - 60),
    Math.min(samples.at(-1)?.frame ?? sample.frame, sample.frame + 90),
    "Hidden vine behavior was observed through vine object, vine tile, sound effect, or climbing state telemetry.",
    {
      progress: sample.progress,
      playerStateName: sample.playerStateName,
      vineTileCount: sample.vineTileCount,
      enemyTypes: sample.enemyTypes,
      soundEffect2: sample.soundEffect2
    },
    inputRanges
  );
}

function softStallFinding(window: StallWindow, inputRanges: ReproInputRange[]): Finding {
  return createFinding(
    "soft-stall",
    "medium",
    window.frameStart,
    window.frameEnd,
    "The agent made no meaningful progress for at least five seconds while the level was active.",
    {
      progress: window.progress,
      frameHash: window.frameHash,
      durationFrames: window.frameEnd - window.frameStart + 1
    },
    inputRanges
  );
}

function isExpectedWorld42SubAreaTransition(previous: FrameSample, sample: FrameSample): boolean {
  return (
    previous.world === 4 &&
    previous.level === 2 &&
    sample.rawWorld === 3 &&
    sample.rawLevel === 2 &&
    sample.world === 4 &&
    sample.level === 3 &&
    previous.warpZoneControl === 0 &&
    sample.warpZoneControl === 0 &&
    !previous.warpZoneVisible &&
    !sample.warpZoneVisible
  );
}

function isWarpAdjacent(sample: FrameSample): boolean {
  return sample.enteringPipe || sample.changeAreaTimer > 0 || sample.warpZoneVisible || sample.warpZoneControl !== 0;
}

function detectDeathLoop(
  samples: FrameSample[],
  metrics: SessionMetrics,
  inputRanges: ReproInputRange[]
): Finding | undefined {
  if (metrics.deaths < 2) {
    return undefined;
  }

  const deathFrames = samples.filter((sample, index) => sample.dying && !samples[index - 1]?.dying).map((sample) => sample.frame);
  const frameStart = Math.max(1, (deathFrames[0] ?? 1) - 120);
  const frameEnd = Math.min(samples.at(-1)?.frame ?? frameStart, (deathFrames.at(-1) ?? frameStart) + 120);

  return createFinding(
    "death-loop",
    "high",
    frameStart,
    frameEnd,
    `The persona died ${metrics.deaths} times in one run, indicating a repeatable failure loop.`,
    {
      deaths: metrics.deaths,
      deathFrames
    },
    inputRanges
  );
}

function detectRouteBlocked(
  samples: FrameSample[],
  metrics: SessionMetrics,
  inputRanges: ReproInputRange[]
): Finding | undefined {
  if (samples.length < 60 * 30 || metrics.maxProgress >= 320 || metrics.transitions > 0) {
    return undefined;
  }

  const last = samples.at(-1);
  const frameEnd = last?.frame ?? samples.length;
  return createFinding(
    "route-blocked",
    "medium",
    Math.max(1, frameEnd - 300),
    frameEnd,
    "The persona stayed near the start of World 4-2 for most of the run without entering a transition.",
    {
      maxProgress: metrics.maxProgress,
      transitions: metrics.transitions,
      finalProgress: last?.progress
    },
    inputRanges
  );
}

function detectImpossibleTransition(samples: FrameSample[], inputRanges: ReproInputRange[]): Finding | undefined {
  const sample = samples.find((candidate) => {
    return candidate.world < 1 || candidate.world > 8 || candidate.level < 1 || candidate.level > 4;
  });

  if (!sample) {
    return undefined;
  }

  return createFinding(
    "impossible-transition",
    "high",
    Math.max(1, sample.frame - 120),
    Math.min(samples.at(-1)?.frame ?? sample.frame, sample.frame + 60),
    `The game entered an out-of-range world/level value: ${sample.world}-${sample.level}.`,
    {
      world: sample.world,
      level: sample.level,
      rawWorld: sample.rawWorld,
      rawLevel: sample.rawLevel,
      gameMode: sample.gameMode,
      levelLoading: sample.levelLoading
    },
    inputRanges
  );
}

function detectTransitionLoop(
  samples: FrameSample[],
  metrics: SessionMetrics,
  inputRanges: ReproInputRange[]
): Finding | undefined {
  if (metrics.transitions < 8) {
    return undefined;
  }

  const last = samples.at(-1);
  const frameEnd = last?.frame ?? samples.length;
  return createFinding(
    "transition-loop",
    metrics.transitions >= 16 ? "high" : "medium",
    Math.max(1, frameEnd - 600),
    frameEnd,
    `The episode triggered ${metrics.transitions} level/loading transitions, suggesting a possible transition loop or unstable route.`,
    {
      transitions: metrics.transitions,
      maxProgress: metrics.maxProgress,
      finalWorld: last?.world,
      finalLevel: last?.level,
      finalProgress: last?.progress
    },
    inputRanges
  );
}

function computeCoverage(samples: FrameSample[]): string[] {
  const coverage = new Set<string>();

  for (const sample of samples) {
    if (sample.dying) {
      break;
    }

    if (sample.vineVisible) coverage.add("hidden-vine");
    if (sample.warpZoneVisible) coverage.add("warp-zone");
    if (sample.enteringPipe || sample.changeAreaTimer > 0) coverage.add("warp-pipe");
    if (sample.pipeTileCount > 0) coverage.add("pipe-tiles");
    if (sample.hiddenBlockTileCount > 0) coverage.add("hidden-blocks");
    if (sample.powerupDrawn || sample.powerupState > 0) coverage.add("powerup");
    if (sample.enemyTypes.some((type) => type > 0)) coverage.add("enemies");
    if (sample.enemyTypes.some((type) => type >= 0x24 && type <= 0x2c)) coverage.add("moving-lifts");
    if ((sample.areaMusic & 0x04) !== 0 && sample.areaOffset !== 0) coverage.add("coin-room");
  }

  return [...coverage].sort();
}

function classifyStatus(metrics: SessionMetrics, findings: Finding[]): SessionStatus {
  if (findings.some((finding) => finding.severity === "high" || finding.type === "route-blocked")) {
    return "failed";
  }
  if (metrics.frames === 0 || (metrics.frames >= 300 && metrics.maxProgress < 80)) {
    return "inconclusive";
  }
  return "passed";
}

function createFinding(
  type: FindingType,
  severity: Severity,
  frameStart: number,
  frameEnd: number,
  summary: string,
  evidence: Record<string, unknown>,
  inputRanges: ReproInputRange[]
): Finding {
  return {
    type,
    severity,
    frameStart,
    frameEnd,
    summary,
    evidence,
    reproInputs: sliceInputRanges(inputRanges, frameStart, frameEnd)
  };
}

function findConsecutive(
  samples: FrameSample[],
  minFrames: number,
  predicate: (sample: FrameSample, index: number) => boolean
): { frameStart: number; frameEnd: number; sample: FrameSample } | undefined {
  let start: FrameSample | undefined;
  let last: FrameSample | undefined;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (predicate(sample, index)) {
      start ??= sample;
      last = sample;
      continue;
    }

    if (start && last && last.frame - start.frame + 1 >= minFrames) {
      return { frameStart: start.frame, frameEnd: last.frame, sample: start };
    }

    start = undefined;
    last = undefined;
  }

  if (start && last && last.frame - start.frame + 1 >= minFrames) {
    return { frameStart: start.frame, frameEnd: last.frame, sample: start };
  }

  return undefined;
}

function buttonsAtFrame(inputRanges: ReproInputRange[], frame: number): string[] {
  return inputRanges.find((range) => range.frameStart <= frame && range.frameEnd >= frame)?.buttons ?? [];
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
  }
}
