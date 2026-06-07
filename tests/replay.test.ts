import { describe, expect, it } from "vitest";
import { analyzeSession } from "../src/detectors.js";
import { buttonsForFrame, hasReplayInputs } from "../src/replay.js";
import type { FrameSample, ReproInputRange } from "../src/types.js";

describe("replay input expansion", () => {
  it("resolves the active button set for a frame", () => {
    const ranges: ReproInputRange[] = [
      { frameStart: 1, frameEnd: 10, buttons: ["B", "RIGHT"] },
      { frameStart: 11, frameEnd: 20, buttons: ["A", "B", "RIGHT"] }
    ];

    expect(buttonsForFrame(ranges, 5)).toEqual(["B", "RIGHT"]);
    expect(buttonsForFrame(ranges, 11)).toEqual(["A", "B", "RIGHT"]);
    expect(buttonsForFrame(ranges, 99)).toEqual([]);
  });

  it("exposes full replay inputs on session results", () => {
    const inputRanges: ReproInputRange[] = [{ frameStart: 1, frameEnd: 2, buttons: ["RIGHT"] }];
    const result = analyzeSession("baseline", [sample(1), sample(2)], inputRanges);

    expect(hasReplayInputs(result)).toBe(true);
    expect(result.replayInputs).toEqual(inputRanges);
  });
});

function sample(frame: number): FrameSample {
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
    pipeInteraction: false
  };
}
