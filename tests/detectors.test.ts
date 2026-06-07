import { describe, expect, it } from "vitest";
import { analyzeSession, computeMetrics, findStallWindows } from "../src/detectors.js";
import type { FrameSample, ReproInputRange } from "../src/types.js";

const INPUTS: ReproInputRange[] = [{ frameStart: 1, frameEnd: 1000, buttons: ["B", "RIGHT"] }];

describe("detectors", () => {
  it("detects a wrong-warp candidate when 4-2 changes worlds during a warp-adjacent sequence", () => {
    const samples = [
      sample(1, { world: 4, level: 2 }),
      sample(2, { world: 4, level: 2, enteringPipe: true, changeAreaTimer: 1, warpZoneControl: 4 }),
      sample(3, { world: 5, level: 1, enteringPipe: true, changeAreaTimer: 1, warpZoneControl: 4 })
    ];

    const result = analyzeSession("glitch-hunter", samples, INPUTS);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        type: "wrong-warp-candidate",
        severity: "high"
      })
    );
    expect(result.status).toBe("failed");
  });

  it("does not report a normal 4-2 sub-area transition as a wrong warp", () => {
    const samples = [
      sample(1, { world: 4, level: 2, rawWorld: 3, rawLevel: 1, changeAreaTimer: 1, enteringPipe: true }),
      sample(2, { world: 4, level: 3, rawWorld: 3, rawLevel: 2, changeAreaTimer: 0, enteringPipe: false })
    ];

    const result = analyzeSession("glitch-hunter", samples, INPUTS);

    expect(result.findings).not.toContainEqual(expect.objectContaining({ type: "wrong-warp-candidate" }));
  });

  it("detects sustained wall or pipe clipping risk", () => {
    const samples = Array.from({ length: 20 }, (_, index) => {
      return sample(index + 1, {
        playerCollisionBits: 0xfe,
        horizontalSpeedAbs: 6,
        pipeInteraction: true,
        pipeTileCount: 2
      });
    });

    const result = analyzeSession("glitch-hunter", samples, INPUTS);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        type: "wall-clip-risk",
        severity: "medium"
      })
    );
  });

  it("detects sustained wall pressure with low movement as clip risk", () => {
    const samples = Array.from({ length: 24 }, (_, index) => {
      return sample(index + 1, {
        progress: 300,
        xOnScreen: 120,
        pipeInteraction: true,
        pipeTileCount: 2,
        scrollLock: 1,
        scrollAmount: 0,
        horizontalSpeedAbs: 0,
        playerCollisionBits: 0xff
      });
    });

    const result = analyzeSession("glitch-hunter", samples, INPUTS);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        type: "wall-clip-risk",
        evidence: expect.objectContaining({
          scrollLock: 1,
          inputPressure: expect.arrayContaining(["RIGHT"])
        })
      })
    );
  });

  it("detects hidden vine coverage and finding evidence", () => {
    const samples = [sample(1), sample(2, { vineVisible: true, vineTileCount: 1, soundEffect2: 0x04 })];

    const result = analyzeSession("completionist", samples, INPUTS);

    expect(result.coverage).toContain("hidden-vine");
    expect(result.findings).toContainEqual(expect.objectContaining({ type: "hidden-vine", severity: "info" }));
  });

  it("detects soft stalls from unchanged progress and frame hash", () => {
    const samples = Array.from({ length: 301 }, (_, index) => {
      return sample(index + 1, { progress: 120, frameHash: "same-frame", horizontalSpeedAbs: 0 });
    });

    expect(findStallWindows(samples)).toHaveLength(1);

    const result = analyzeSession("baseline", samples, INPUTS);
    expect(result.metrics.stalls).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({ type: "soft-stall" }));
  });

  it("detects death loops from repeated death transitions", () => {
    const samples = [
      sample(1, { dying: false }),
      sample(10, { dying: true }),
      sample(20, { dying: false }),
      sample(30, { dying: true })
    ];

    expect(computeMetrics(samples).deaths).toBe(2);

    const result = analyzeSession("baseline", samples, INPUTS);
    expect(result.findings).toContainEqual(expect.objectContaining({ type: "death-loop", severity: "high" }));
  });

  it("does not count progress or coverage from dying samples", () => {
    const samples = [
      sample(1, { progress: 120 }),
      sample(2, {
        dying: true,
        progress: 900,
        vineVisible: true,
        warpZoneVisible: true,
        hiddenBlockTileCount: 1
      }),
      sample(3, {
        dying: false,
        world: 1,
        level: 1,
        progress: 1200,
        vineVisible: true,
        warpZoneVisible: true,
        hiddenBlockTileCount: 1,
        gameMode: 0
      })
    ];

    const result = analyzeSession("baseline", samples, INPUTS);

    expect(result.metrics.maxProgress).toBe(120);
    expect(result.metrics.deaths).toBe(1);
    expect(result.coverage).not.toContain("hidden-vine");
    expect(result.coverage).not.toContain("warp-zone");
    expect(result.coverage).not.toContain("hidden-blocks");
    expect(result.findings).not.toContainEqual(expect.objectContaining({ type: "wrong-warp-candidate" }));
    expect(result.findings).not.toContainEqual(expect.objectContaining({ type: "hidden-vine" }));
  });

  it("detects route-blocked runs when progress stays near the start", () => {
    const samples = Array.from({ length: 1800 }, (_, index) => sample(index + 1, { progress: 64 }));

    const result = analyzeSession("baseline", samples, INPUTS);

    expect(result.findings).toContainEqual(expect.objectContaining({ type: "route-blocked" }));
    expect(result.status).toBe("failed");
  });
});

function sample(frame: number, overrides: Partial<FrameSample> = {}): FrameSample {
  return {
    frame,
    frameHash: `hash-${frame}`,
    rawWorld: 3,
    rawLevel: 1,
    world: 4,
    level: 2,
    playerState: 0x08,
    playerStateName: "normal",
    playerFloatState: 0,
    currentScreen: 0,
    nextScreen: 0,
    xOnScreen: 100,
    yOnScreen: 180,
    levelPage: 0,
    progress: 100,
    horizontalSpeed: 0,
    horizontalSpeedAbs: 0,
    verticalVelocity: 0,
    lives: 3,
    coins: 0,
    gameTimer: 400,
    gameMode: 1,
    levelLoading: 0,
    levelEntry: 0,
    scrollLock: 0,
    scrollAmount: 0,
    areaOffset: 0,
    areaMusic: 0x04,
    eventMusic: 0,
    soundEffect1: 0,
    soundEffect2: 0,
    soundEffect3: 0,
    playerCollisionBits: 0xff,
    enemyCollisionBits: 0,
    playerHitDetectFlag: 0,
    warpZoneControl: 0,
    changeAreaTimer: 0,
    deathMusicLoaded: 0,
    preLevel: 0,
    powerupDrawn: 0,
    powerupState: 0,
    powerupType: 0,
    enemyTypes: [0, 0, 0, 0, 0],
    vineTileCount: 0,
    pipeTileCount: 0,
    hiddenBlockTileCount: 0,
    onVine: false,
    enteringPipe: false,
    dying: false,
    vineVisible: false,
    warpZoneVisible: false,
    pipeInteraction: false,
    ...overrides
  };
}
