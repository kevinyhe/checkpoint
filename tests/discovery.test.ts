import { describe, expect, it } from "vitest";
import {
  CheckpointActionFuzzer,
  chooseArchiveEntry,
  classifyWorld42CoverageGoals,
  chooseFullRunEvolutionParent,
  computeGameScoreStats,
  computeMilestoneFrames,
  computeRoomStats,
  createArchiveCell,
  createBaselineProgressControllerConfig,
  createOverlaySamples,
  createRouteSeedControllerConfig,
  CoverageGoalController,
  defaultEpisodeLogPath,
  detectForwardObstacleWindow,
  expandMacroTrace,
  formatEpisodeLogPathForRun,
  generateForwardRouteTrace,
  mutateMacroTrace,
  mutateFullRunTrace,
  macroTraceFromReplayInputs,
  ProgressController,
  scoreArchiveSelection,
  scoreBugHotspot,
  scoreCoverageGoals,
  scoreCoverageParent,
  scoreDiscoveryEpisode,
  scoreGameScoreDelta,
  scoreRouteEfficiency,
  scoreRooms,
  scoreSpeedMilestones,
  selectSavedDiscoverySessions,
  scoreFindings,
  shouldKeepCheckpointAfterEpisode,
  summarizeWorld42CoverageGoals,
  upsertArchiveCheckpoint,
  VINE_WARP_TARGET_PROGRESS,
  WallClipProbeController,
  WallClipTrickController,
  WarpZoneProbeController,
  type ArchiveCheckpointInput,
  type ArchiveEntry,
  type MacroStep
} from "../src/discovery.js";
import { createSeededRandom } from "../src/rng.js";
import type { Finding, SessionResult, SmbRamSnapshot } from "../src/types.js";

describe("coverage-guided discovery", () => {
  it("expands macro traces into compressed replay inputs", () => {
    const trace: MacroStep[] = [
      { action: "right-b", frames: 10 },
      { action: "jump-right", frames: 5 },
      { action: "idle", frames: 5 }
    ];

    expect(expandMacroTrace(trace, 20)).toEqual([
      { frameStart: 1, frameEnd: 10, buttons: ["B", "RIGHT"] },
      { frameStart: 11, frameEnd: 15, buttons: ["A", "B", "RIGHT"] },
      { frameStart: 16, frameEnd: 20, buttons: [] }
    ]);
  });

  it("mutates traces deterministically from a seed", () => {
    const trace: MacroStep[] = [
      { action: "right-b", frames: 30 },
      { action: "jump-right", frames: 20 }
    ];

    const first = mutateMacroTrace(trace, createSeededRandom(123), 120);
    const second = mutateMacroTrace(trace, createSeededRandom(123), 120);

    expect(first).toEqual(second);
    expect(first.trace.reduce((total, step) => total + step.frames, 0)).toBe(120);
  });

  it("mutates full-run traces around failure windows deterministically", () => {
    const trace: MacroStep[] = [
      { action: "right-b", frames: 80 },
      { action: "jump-right", frames: 80 },
      { action: "right-b", frames: 80 }
    ];
    const parent = session({ score: 200, bugScore: 0, progressScore: 200, maxProgress: 400, deaths: 1 });
    const first = mutateFullRunTrace(trace, parent, createSeededRandom(55), 300);
    const second = mutateFullRunTrace(trace, parent, createSeededRandom(55), 300);

    expect(first).toEqual(second);
    expect(first.trace.reduce((total, step) => total + step.frames, 0)).toBe(300);
  });

  it("generates route-first full-run traces without waiting or backtracking", () => {
    const trace = generateForwardRouteTrace(createSeededRandom(7), 900);

    expect(trace.reduce((total, step) => total + step.frames, 0)).toBe(900);
    expect(trace.map((step) => step.action)).not.toContain("left");
    expect(trace.map((step) => step.action)).not.toContain("short-hop-left");
    expect(trace.map((step) => step.action)).not.toContain("oscillate");
    expect(trace.map((step) => step.action)).not.toContain("idle");
    expect(trace[0]?.action).toBe("right-b");
  });

  it("converts executed replay inputs back into evolvable route macros", () => {
    const trace = macroTraceFromReplayInputs([
      { frameStart: 1, frameEnd: 30, buttons: ["B", "RIGHT"] },
      { frameStart: 31, frameEnd: 42, buttons: ["UP", "RIGHT"] },
      { frameStart: 43, frameEnd: 60, buttons: ["B", "DOWN", "RIGHT"] }
    ]);

    expect(trace).toEqual([
      { action: "right-b", frames: 30 },
      { action: "climb-right", frames: 12 },
      { action: "pipe-hold", frames: 18 }
    ]);
  });

  it("rewards fast alive forward routes over dying stalls", () => {
    const fast = [
      frameSample(1, { progress: 0 }),
      frameSample(60, { progress: 240 }),
      frameSample(120, { progress: VINE_WARP_TARGET_PROGRESS })
    ];
    const dying = [
      frameSample(1, { progress: 0 }),
      frameSample(120, { progress: 80 }),
      frameSample(180, { progress: 60, dying: true })
    ];

    expect(scoreRouteEfficiency(fast, 0)).toBeGreaterThan(scoreRouteEfficiency(dying, 1));
  });

  it("detects forward-input obstacle windows before route mutation", () => {
    const samples = Array.from({ length: 70 }, (_, index) =>
      frameSample(index + 1, {
        progress: index < 8 ? 300 + index : 308,
        horizontalSpeedAbs: index < 8 ? 16 : 0,
        playerCollisionBits: index < 8 ? 0xff : 0xfe
      })
    );
    const replayInputs = [{ frameStart: 1, frameEnd: 70, buttons: ["B", "RIGHT"] as const }];

    const obstacle = detectForwardObstacleWindow(samples, replayInputs);

    expect(obstacle).toMatchObject({
      progress: 308,
      reason: "forward-input-blocked-by-geometry"
    });
    expect(obstacle?.durationFrames).toBeGreaterThanOrEqual(42);
  });

  it("mutates obstacle windows with jump timing sweeps", () => {
    const trace: MacroStep[] = [
      { action: "right-b", frames: 180 },
      { action: "right-b", frames: 180 },
      { action: "right-b", frames: 180 }
    ];
    const parent = session({
      score: 400,
      bugScore: 0,
      progressScore: 400,
      maxProgress: 720,
      speedScore: 80,
      obstacleFrame: 260
    });

    const result = mutateFullRunTrace(trace, parent, createSeededRandom(4), 540);

    expect(result.mutation).toContain("obstacle");
    expect(result.trace.reduce((total, step) => total + step.frames, 0)).toBe(540);
    expect(result.trace.some((step) => step.action === "jump-right")).toBe(true);
    expect(result.trace.map((step) => step.action)).not.toContain("idle");
    expect(result.trace.map((step) => step.action)).not.toContain("left");
  });

  it("derives portable episode sidecar paths", () => {
    expect(defaultEpisodeLogPath("runs/world-4-2.discovery.json").replaceAll("\\", "/")).toBe(
      "runs/world-4-2.discovery.episodes.jsonl"
    );
    expect(formatEpisodeLogPathForRun("runs/world-4-2.discovery.json", "runs/world-4-2.discovery.episodes.jsonl")).toBe(
      "world-4-2.discovery.episodes.jsonl"
    );
  });

  it("thins overlay samples while preserving findings and stopping at death", () => {
    const samples = Array.from({ length: 12 }, (_, index) => frameSample(index + 1, { progress: index * 10 }));
    samples[10] = frameSample(11, { progress: 110, dying: true });
    const overlays = createOverlaySamples(samples, [finding("wall-clip-risk", "medium", 6, 7)]);

    expect(overlays.map((sample) => sample.frame)).toEqual([1, 4, 6, 7, 8, 11]);
    expect(overlays.find((sample) => sample.frame === 11)?.dying).toBe(true);
    expect(overlays.find((sample) => sample.frame === 12)).toBeUndefined();
    expect(overlays[0]).toMatchObject({ rawLevel: 1, currentScreen: 2, x: 80, y: 170 });
  });

  it("creates stable archive cells from SMB telemetry", () => {
    expect(createArchiveCell(snapshot())).toBe(
      "w4-2|s2|x2|y5|p8|pipe.no-vine.warp.free.alive.active|e10100"
    );
  });

  it("classifies world 4-2 coverage goals from SMB telemetry", () => {
    const goals = classifyWorld42CoverageGoals(
      snapshot({
        progress: 710,
        yOnScreen: 112,
        hiddenBlockTileCount: 2,
        vineVisible: true,
        warpZoneVisible: true,
        enteringPipe: true
      })
    );
    const summary = summarizeWorld42CoverageGoals(goals);

    expect([...goals]).toEqual(
      expect.arrayContaining([
        "mid-route",
        "upper-block-route",
        "high-route",
        "hidden-blocks",
        "hidden-vine",
        "warp-zone",
        "warp-pipe"
      ])
    );
    expect(summary.covered).toBeGreaterThan(0);
    expect(summary.missing).not.toContain("hidden-vine");
  });

  it("scores novelty and bug signals above plain progress", () => {
    const wrongWarp = finding("wrong-warp-candidate", "high");
    const plainScore = scoreDiscoveryEpisode(
      {
        metrics: { frames: 60, gameSeconds: 1, maxProgress: 200, deaths: 0, stalls: 0, transitions: 0 },
        coverage: [],
        findings: []
      },
      new Set(["a"]),
      0
    );
    const bugScore = scoreDiscoveryEpisode(
      {
        metrics: { frames: 60, gameSeconds: 1, maxProgress: 200, deaths: 0, stalls: 0, transitions: 1 },
        coverage: ["warp-pipe"],
        findings: [wrongWarp]
      },
      new Set(["a", "b"]),
      2
    );

    expect(scoreFindings([wrongWarp])).toBeGreaterThan(0);
    expect(bugScore).toBeGreaterThan(plainScore);
  });

  it("scores missing coverage goals above repeated coverage", () => {
    const goals = ["hidden-vine", "upper-block-route", "progress-05"];

    expect(scoreCoverageGoals(goals, [])).toBeGreaterThan(scoreCoverageGoals(goals, goals));
  });

  it("does not let dead no-bug runs outrank meaningful survivors on score alone", () => {
    const deadHighCoverage = scoreDiscoveryEpisode(
      {
        metrics: { frames: 1892, gameSeconds: 31.53, maxProgress: 1636, deaths: 1, stalls: 0, transitions: 0 },
        coverage: [],
        findings: []
      },
      new Set(Array.from({ length: 119 }, (_, index) => `cell-${index}`)),
      102,
      0,
      {
        coverageScore: 1544,
        speedScore: 202.83,
        roomScore: 144,
        gameScore: 83.33,
        startProgress: 104,
        targetReached: true
      }
    );
    const survivor = scoreDiscoveryEpisode(
      {
        metrics: { frames: 2400, gameSeconds: 40, maxProgress: 1000, deaths: 0, stalls: 0, transitions: 0 },
        coverage: ["pipe-tiles"],
        findings: []
      },
      new Set(["a", "b", "c", "d"]),
      4,
      0,
      { coverageScore: 120, speedScore: 80, roomScore: 24 }
    );

    expect(deadHighCoverage).toBeLessThan(1000);
    expect(deadHighCoverage).toBeLessThan(survivor);
  });

  it("rewards faster milestone arrival over slow equivalent progress", () => {
    const fast = scoreSpeedMilestones({ "progress-512": 300, "hidden-vine": 900 });
    const slow = scoreSpeedMilestones({ "progress-512": 1500, "hidden-vine": 2200 });

    expect(fast).toBeGreaterThan(slow);
  });

  it("scores room transitions and SMB score gains", () => {
    const samples = [
      frameSample(1, { score: 1000, roomId: "main" }),
      frameSample(20, { score: 1500, roomId: "main" }),
      frameSample(40, { score: 2500, roomId: "coin-room", areaMusic: 0x04, areaOffset: 3 })
    ];
    const rooms = computeRoomStats(samples);
    const milestones = computeMilestoneFrames(samples);
    const game = computeGameScoreStats(samples);

    expect(rooms.transitions).toBe(1);
    expect(scoreRooms(rooms)).toBeGreaterThan(0);
    expect(milestones["coin-room"]).toBe(40);
    expect(game.delta).toBe(1500);
    expect(scoreGameScoreDelta(game.delta)).toBeGreaterThan(0);
  });

  it("uses a RAM-feedback progress controller for default route movement", () => {
    const controller = new ProgressController(createRouteSeedControllerConfig(1));

    expect(controller.buttons(1, snapshot({ progress: 10 }), 1200)).toEqual(["B", "RIGHT"]);
    expect(controller.buttons(100, snapshot({ progress: VINE_WARP_TARGET_PROGRESS, vineVisible: true }), 1200)).toEqual([
      "UP",
      "RIGHT"
    ]);
    expect(controller.buttons(101, snapshot({ progress: 400, enteringPipe: true }), 1200)).toEqual(["DOWN", "RIGHT"]);
  });

  it("uses a forward-only pulse controller in the 4-2 sub-area", () => {
    const controller = new ProgressController(createRouteSeedControllerConfig(1));
    const checkpointController = new ProgressController(createRouteSeedControllerConfig(1));

    expect(controller.buttons(560, snapshot({ rawLevel: 2, level: 3, progress: 120 }), 1200)).toEqual(["B", "RIGHT"]);
    expect(controller.buttons(560, snapshot({ rawLevel: 2, level: 3, progress: 260 }), 1200)).toEqual(["A", "B", "RIGHT"]);
    expect(checkpointController.buttons(40, snapshot({ rawLevel: 2, level: 3, progress: 260 }), 1200)).toEqual([
      "A",
      "B",
      "RIGHT"
    ]);

    const pulseButtons = Array.from({ length: 25 }, (_, index) =>
      controller.buttons(561 + index, snapshot({ rawLevel: 2, level: 3, progress: 590 }), 1200)
    );
    expect(pulseButtons.slice(0, 21).every((buttons) => buttons.join("+") === "A+B+RIGHT")).toBe(true);
    expect(pulseButtons.slice(21).every((buttons) => buttons.length === 0)).toBe(true);
    expect(pulseButtons.flat()).not.toContain("LEFT");
  });

  it("keeps the deeper 4-2 frontier route forward-only", () => {
    const controller = new ProgressController(createRouteSeedControllerConfig(1));

    expect(controller.buttons(1000, snapshot({ rawLevel: 2, level: 3, progress: 900 }), 1800)).toEqual([
      "A",
      "B",
      "RIGHT"
    ]);
    expect(controller.buttons(1500, snapshot({ rawLevel: 2, level: 3, progress: 1530 }), 1800)).toEqual([
      "A",
      "B",
      "RIGHT"
    ]);
    expect(controller.buttons(1700, snapshot({ rawLevel: 2, level: 3, progress: 1650 }), 1800)).toEqual([
      "B",
      "RIGHT"
    ]);
  });

  it("uses checkpoint-local action fuzzing for varied progress attempts", () => {
    const fuzzer = new CheckpointActionFuzzer(createSeededRandom(135), createRouteSeedControllerConfig(1));
    const observed = new Set<string>();

    for (let frame = 1; frame <= 80; frame += 1) {
      observed.add(fuzzer.buttons(frame, snapshot({ progress: 260 }), 1200).join("+"));
    }

    expect(observed.size).toBeGreaterThan(1);
    expect([...observed].some((buttons) => buttons.includes("RIGHT"))).toBe(true);
  });

  it("keeps pre-target checkpoint fuzzing biased toward forward progress", () => {
    const fuzzer = new CheckpointActionFuzzer(createSeededRandom(246), createRouteSeedControllerConfig(1));
    const observed = new Set<string>();

    for (let frame = 1; frame <= 120; frame += 1) {
      observed.add(fuzzer.buttons(frame, snapshot({ progress: 260 }), 1200).join("+"));
    }

    expect([...observed].every((buttons) => buttons.includes("RIGHT"))).toBe(true);
    expect([...observed].some((buttons) => buttons.includes("LEFT"))).toBe(false);
    expect(observed.has("")).toBe(false);
  });

  it("weights deeper checkpoint cells above repeatedly visited shallow cells", () => {
    const shallow = archiveEntry({ progress: 120, bestProgress: 120, visits: 8, novelty: 0 });
    const deep = archiveEntry({ progress: 900, bestProgress: 900, visits: 0, novelty: 1 });

    expect(scoreArchiveSelection(deep)).toBeGreaterThan(scoreArchiveSelection(shallow));
    expect(chooseArchiveEntry([shallow, deep], () => 0.99)).toBe(deep);
  });

  it("downranks checkpoints that repeatedly lead to deaths", () => {
    const safe = archiveEntry({
      progress: 620,
      bestProgress: 620,
      attempts: 4,
      deaths: 0,
      successes: 4,
      bestSurvivalFrames: 1800
    });
    const deathProne = archiveEntry({
      progress: 620,
      bestProgress: 620,
      attempts: 4,
      deaths: 4,
      successes: 0,
      bestSurvivalFrames: 120
    });

    expect(scoreArchiveSelection(safe)).toBeGreaterThan(scoreArchiveSelection(deathProne));
  });

  it("scores bug-hotspot checkpoints above plain progress cells", () => {
    const plain = archiveEntry({ cell: "w4-2|s3|x4|y5|p8|no-pipe.no-vine.no-warp.free.alive.active|e00000", reason: "progress-bucket", progress: 700 });
    const warp = archiveEntry({ cell: "w4-2|s3|x4|y5|p8|pipe.no-vine.warp.free.alive.active|e00000", reason: "warp-zone-visible", progress: 520 });
    const wall = archiveEntry({ cell: "w4-2|s3|x4|y5|p8|pipe.no-vine.no-warp.free.alive.active|e00000", reason: "pipe-adjacent", progress: 520, bugScore: 24 });

    expect(scoreBugHotspot(warp, "warp-zone")).toBeGreaterThan(scoreBugHotspot(plain, "warp-zone"));
    expect(scoreBugHotspot(wall, "wall-clip")).toBeGreaterThan(scoreBugHotspot(plain, "wall-clip"));
  });

  it("scores undercovered checkpoints above already covered deep checkpoints", () => {
    const missing = ["hidden-vine", "upper-block-route"];
    const undercovered = archiveEntry({
      coverageGoals: ["hidden-vine", "upper-block-route", "progress-05"],
      progress: 640,
      bestProgress: 640,
      visits: 0
    });
    const repeatedDeep = archiveEntry({
      coverageGoals: ["deep-frontier", "progress-13"],
      progress: 1600,
      bestProgress: 1600,
      visits: 6
    });

    expect(scoreCoverageParent(undercovered, missing)).toBeGreaterThan(scoreCoverageParent(repeatedDeep, missing));
  });

  it("uses RAM-reactive warp and wall probe controllers", () => {
    const warpProbe = new WarpZoneProbeController(createSeededRandom(7), createRouteSeedControllerConfig(1));
    const wallProbe = new WallClipProbeController(createSeededRandom(9), createRouteSeedControllerConfig(1));

    const warpButtons = new Set<string>();
    const wallButtons = new Set<string>();
    for (let frame = 1; frame <= 90; frame += 1) {
      warpButtons.add(
        warpProbe
          .buttons(frame, snapshot({ pipeInteraction: true, warpZoneVisible: true, warpZoneControl: 4 }), 1200)
          .join("+")
      );
      wallButtons.add(
        wallProbe
          .buttons(frame, snapshot({ pipeInteraction: true, pipeTileCount: 2, scrollLock: 1, horizontalSpeedAbs: 0 }), 1200)
          .join("+")
      );
    }

    expect([...warpButtons].some((buttons) => buttons.includes("DOWN+RIGHT") || buttons.includes("UP+RIGHT"))).toBe(true);
    expect([...wallButtons].some((buttons) => buttons.includes("RIGHT"))).toBe(true);
    expect(wallButtons.size).toBeGreaterThan(1);
  });

  it("uses a deterministic 4-2 wall-clip trick sequence near pipe geometry", () => {
    const controller = new WallClipTrickController(createSeededRandom(17), createRouteSeedControllerConfig(1));

    expect(
      controller.buttons(1, snapshot({ progress: 40, pipeInteraction: false, pipeTileCount: 0, warpZoneVisible: false }), 1200)
    ).toEqual(["B", "RIGHT"]);
    expect(controller.buttons(40, snapshot({ progress: 320, pipeInteraction: false, pipeTileCount: 0, warpZoneVisible: false }), 1200)).toEqual([
      "A",
      "B",
      "RIGHT"
    ]);

    const trickButtons = new Set<string>();
    for (let frame = 1; frame <= 110; frame += 1) {
      trickButtons.add(
        controller
          .buttons(
            frame,
            snapshot({
              progress: 640,
              pipeInteraction: true,
              pipeTileCount: 2,
              scrollLock: 1,
              playerCollisionBits: 0xfb,
              horizontalSpeedAbs: 16,
              warpZoneVisible: false
            }),
            1200
          )
          .join("+")
      );
    }

    expect([...trickButtons]).toEqual(
      expect.arrayContaining(["B+RIGHT", "RIGHT", "B", "B+LEFT", "B+DOWN+RIGHT", "A+B+RIGHT", "A+RIGHT"])
    );
  });

  it("uses RAM-reactive coverage exploration for missing route goals", () => {
    const upperController = new CoverageGoalController(createSeededRandom(5), createRouteSeedControllerConfig(1), [
      "upper-block-route",
      "hidden-blocks"
    ]);
    const pipeController = new CoverageGoalController(createSeededRandom(5), createRouteSeedControllerConfig(1), ["coin-room"]);

    expect(upperController.buttons(20, snapshot({ progress: 320, yOnScreen: 170 }), 1200)).toEqual(["A", "B", "RIGHT"]);

    const pipeButtons = new Set<string>();
    for (let frame = 1; frame <= 50; frame += 1) {
      pipeButtons.add(pipeController.buttons(frame, snapshot({ pipeInteraction: true, pipeTileCount: 2 }), 1200).join("+"));
    }

    expect([...pipeButtons].some((buttons) => buttons.includes("DOWN+RIGHT"))).toBe(true);
  });

  it("saves bug candidates alongside high-progress sessions in balanced focus", () => {
    const bug = session({ score: 110, bugScore: 85, progressScore: 25, maxProgress: 300, findings: [finding("wall-clip-risk", "medium")] });
    const progress = session({ score: 300, bugScore: 0, progressScore: 300, maxProgress: 900 });
    const shallow = session({ score: 50, bugScore: 0, progressScore: 50, maxProgress: 500 });

    const saved = selectSavedDiscoverySessions([progress, shallow, bug], 2, "balanced");

    expect(saved).toContain(bug);
    expect(saved).toContain(progress);
  });

  it("keeps a Go-Explore bug phase representative for hybrid balanced output", () => {
    const rlBest = session({ score: 500, bugScore: 0, progressScore: 500, maxProgress: 900, phase: "rl-explore" });
    const rlSecond = session({ score: 450, bugScore: 0, progressScore: 450, maxProgress: 850, phase: "rl-explore" });
    const bugPhase = session({ score: 40, bugScore: 0, progressScore: 40, maxProgress: 300, phase: "go-explore-bug" });

    const saved = selectSavedDiscoverySessions([rlBest, rlSecond, bugPhase], 2, "balanced");

    expect(saved).toContain(rlBest);
    expect(saved).toContain(bugPhase);
  });

  it("saves coverage-diverse sessions in coverage focus", () => {
    const hidden = session({ score: 120, bugScore: 0, progressScore: 70, maxProgress: 500, coverageGoalsHit: ["hidden-vine"] });
    const coin = session({ score: 110, bugScore: 0, progressScore: 50, maxProgress: 420, coverageGoalsHit: ["coin-room"] });
    const progress = session({ score: 260, bugScore: 0, progressScore: 260, maxProgress: 1200, coverageGoalsHit: ["progress-09"] });

    const saved = selectSavedDiscoverySessions([progress, hidden, coin], 2, "coverage");

    expect(saved).toContain(hidden);
    expect(saved).toContain(coin);
  });

  it("selects high-performing full-run parents from elite buckets", () => {
    const slow = discoveryEpisode(session({ score: 40, bugScore: 0, progressScore: 40, maxProgress: 260 }));
    const fast = discoveryEpisode(
      session({
        score: 300,
        bugScore: 0,
        progressScore: 120,
        maxProgress: 900,
        speedScore: 180,
        gameScoreDelta: 1000,
        roomTransitions: 2
      })
    );

    expect(chooseFullRunEvolutionParent([slow, fast], () => 0.5)).toBe(fast);
  });

  it("upserts and prunes checkpoint archive entries by score", () => {
    const archive = new Map<string, ArchiveEntry>();
    const config = createBaselineProgressControllerConfig(1);

    upsertArchiveCheckpoint(archive, checkpoint("a", 100, config), 2);
    upsertArchiveCheckpoint(archive, checkpoint("b", 800, config), 2);
    upsertArchiveCheckpoint(archive, checkpoint("c", 500, config), 2);

    expect(archive.size).toBe(2);
    expect(archive.has("a")).toBe(false);
    expect(archive.has("b")).toBe(true);
    expect(archive.has("c")).toBe(true);
  });

  it("drops checkpoint candidates captured too close to a death", () => {
    expect(shouldKeepCheckpointAfterEpisode({ frame: 100, targetReached: false, bugScore: 0 }, 150)).toBe(false);
    expect(shouldKeepCheckpointAfterEpisode({ frame: 100, targetReached: false, bugScore: 0 }, 220)).toBe(true);
    expect(shouldKeepCheckpointAfterEpisode({ frame: 100, targetReached: true, bugScore: 0 }, 150)).toBe(true);
    expect(shouldKeepCheckpointAfterEpisode({ frame: 100, targetReached: false, bugScore: 40 }, 150)).toBe(true);
  });

  it("heavily rewards deeper progress over repeated shallow loops", () => {
    const shallowLoop = scoreDiscoveryEpisode(
      {
        metrics: { frames: 600, gameSeconds: 10, maxProgress: 120, deaths: 1, stalls: 1, transitions: 10 },
        coverage: [],
        findings: [finding("transition-loop", "medium")]
      },
      new Set(["start"]),
      0
    );
    const deepProgress = scoreDiscoveryEpisode(
      {
        metrics: { frames: 600, gameSeconds: 10, maxProgress: VINE_WARP_TARGET_PROGRESS, deaths: 0, stalls: 0, transitions: 1 },
        coverage: ["pipe-tiles"],
        findings: []
      },
      new Set(["deep-a", "deep-b", "deep-c"]),
      3,
      0,
      { startProgress: 300, targetReached: true }
    );

    expect(deepProgress).toBeGreaterThan(shallowLoop);
  });
});

function finding(type: Finding["type"], severity: Finding["severity"], frameStart = 1, frameEnd = 2): Finding {
  return {
    type,
    severity,
    frameStart,
    frameEnd,
    summary: "test",
    evidence: {},
    reproInputs: []
  };
}

function frameSample(frame: number, overrides: Partial<SmbRamSnapshot> = {}) {
  return {
    frame,
    frameHash: `frame-${frame}`,
    ...snapshot(overrides)
  };
}

function snapshot(overrides: Partial<SmbRamSnapshot> = {}): SmbRamSnapshot {
  return {
    rawWorld: 3,
    rawLevel: 1,
    world: 4,
    level: 2,
    playerState: 8,
    playerStateName: "normal",
    playerFloatState: 0,
    currentScreen: 2,
    nextScreen: 3,
    xOnScreen: 80,
    yOnScreen: 170,
    levelPage: 2,
    progress: 592,
    horizontalSpeed: 0,
    horizontalSpeedAbs: 0,
    verticalVelocity: 0,
    lives: 3,
    coins: 0,
    score: 0,
    gameTimer: 300,
    gameMode: 1,
    levelLoading: 0,
    levelEntry: 0,
    scrollLock: 0,
    scrollAmount: 0,
    areaOffset: 0,
    areaMusic: 0,
    eventMusic: 0,
    soundEffect1: 0,
    soundEffect2: 0,
    soundEffect3: 0,
    playerCollisionBits: 0xff,
    enemyCollisionBits: 0,
    playerHitDetectFlag: 0,
    warpZoneControl: 1,
    changeAreaTimer: 0,
    deathMusicLoaded: 0,
    preLevel: 0,
    powerupDrawn: 0,
    powerupState: 0,
    powerupType: 0,
    enemyTypes: [1, 0, 2, 0, 0],
    vineTileCount: 0,
    pipeTileCount: 1,
    hiddenBlockTileCount: 0,
    onVine: false,
    enteringPipe: false,
    dying: false,
    vineVisible: false,
    warpZoneVisible: true,
    pipeInteraction: true,
    roomId: "w4-2|a0|m0|e0",
    ...overrides
  };
}

function checkpoint(cell: string, progress: number, controllerConfig = createBaselineProgressControllerConfig(1)): ArchiveCheckpointInput {
  return {
    id: `checkpoint-${cell}`,
    cell,
    stateData: { cell, progress },
    replayInputs: [{ frameStart: 1, frameEnd: progress, buttons: ["B", "RIGHT"] }],
    frame: progress,
    progress,
    bestProgress: progress,
    novelty: 1,
    bugScore: 0,
    coverageGoals: [],
    depth: 1,
    targetReached: progress >= VINE_WARP_TARGET_PROGRESS,
    reason: "progress-bucket",
    controllerConfig
  };
}

function archiveEntry(overrides: Partial<ArchiveEntry>): ArchiveEntry {
  const progress = overrides.progress ?? 0;
  return {
    id: "entry",
    cell: "cell",
    stateData: {},
    replayInputs: [],
    frame: progress,
    progress,
    bestProgress: progress,
    visits: 0,
    attempts: 0,
    deaths: 0,
    successes: 0,
    bestSurvivalFrames: 0,
    bestChildProgress: progress,
    novelty: 0,
    bugScore: 0,
    coverageGoals: [],
    score: progress,
    depth: 1,
    targetReached: false,
    reason: "test",
    controllerConfig: createBaselineProgressControllerConfig(1),
    ...overrides
  };
}

function session(options: {
  score: number;
  bugScore: number;
  progressScore: number;
  maxProgress: number;
  findings?: Finding[];
  deaths?: number;
  coverageGoalsHit?: string[];
  speedScore?: number;
  roomScore?: number;
  gameScoreDelta?: number;
  roomTransitions?: number;
  obstacleFrame?: number;
  phase?: "rl-explore" | "go-explore-bug";
}): SessionResult {
  return {
    persona: "coverage-explorer",
    status: "passed",
    metrics: {
      frames: 600,
      gameSeconds: 10,
      maxProgress: options.maxProgress,
      deaths: options.deaths ?? 0,
      stalls: 0,
      transitions: 0
    },
    coverage: [],
    findings: options.findings ?? [],
    replayInputs: [],
    agent: {
      type: "go-explore-checkpoint",
      episode: options.maxProgress,
      episodeId: `episode-${options.maxProgress}`,
      score: options.score,
      newCells: 0,
      cellsVisited: 1,
      uniqueCells: 1,
      bugScore: options.bugScore,
      progressScore: options.progressScore,
      coverageScore: options.coverageGoalsHit?.length ?? 0,
      coverageGoalsHit: options.coverageGoalsHit ?? [],
      routeScore: options.speedScore ?? 0,
      speedScore: options.speedScore ?? 0,
      roomScore: options.roomScore ?? 0,
      gameScore: options.gameScoreDelta ?? 0,
      gameScoreDelta: options.gameScoreDelta ?? 0,
      milestoneFrames: {},
      roomTransitions: options.roomTransitions ?? 0,
      roomsReached: [],
      obstacleFrame: options.obstacleFrame,
      obstacleProgress: options.obstacleFrame === undefined ? undefined : options.maxProgress,
      obstacleDurationFrames: options.obstacleFrame === undefined ? undefined : 60,
      obstacleReason: options.obstacleFrame === undefined ? undefined : "forward-input-blocked-by-geometry",
      phase: options.phase,
      mutation: "test"
    }
  };
}

function discoveryEpisode(sessionResult: SessionResult) {
  return {
    id: sessionResult.agent?.episodeId ?? "episode",
    parentId: undefined,
    trace: [{ action: "right-b" as const, frames: 120 }],
    session: sessionResult,
    cells: new Set<string>(),
    newCells: sessionResult.agent?.newCells ?? 0,
    bugScore: sessionResult.agent?.bugScore ?? 0,
    progressScore: sessionResult.agent?.progressScore ?? 0,
    coverageScore: sessionResult.agent?.coverageScore ?? 0,
    coverageGoalsHit: sessionResult.agent?.coverageGoalsHit ?? [],
    routeScore: sessionResult.agent?.routeScore ?? 0,
    speedScore: sessionResult.agent?.speedScore ?? 0,
    roomScore: sessionResult.agent?.roomScore ?? 0,
    gameScore: sessionResult.agent?.gameScore ?? 0,
    gameScoreDelta: sessionResult.agent?.gameScoreDelta ?? 0,
    milestoneFrames: sessionResult.agent?.milestoneFrames ?? {},
    roomTransitions: sessionResult.agent?.roomTransitions ?? 0,
    roomsReached: sessionResult.agent?.roomsReached ?? [],
    score: sessionResult.agent?.score ?? 0,
    progressDelta: sessionResult.metrics.maxProgress,
    targetReached: sessionResult.agent?.targetReached ?? false,
    mutation: sessionResult.agent?.mutation ?? "test",
    overlaySamples: []
  };
}
