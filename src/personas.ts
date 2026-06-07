import { createSeededRandom } from "./rng.js";
import type { ButtonName, ScriptedPersona, SmbRamSnapshot } from "./types.js";

export function selectPersonaButtons(
  persona: ScriptedPersona,
  frame: number,
  snapshot: SmbRamSnapshot,
  durationFrames: number,
  seed: number
): ButtonName[] {
  const reactive = reactiveButtons(snapshot);
  if (reactive) {
    return reactive;
  }

  switch (persona) {
    case "glitch-hunter":
      return glitchHunterButtons(frame, seed);
    case "completionist":
      return completionistButtons(frame, snapshot, durationFrames, seed);
    case "baseline":
      return baselineButtons(frame, seed);
  }
}

function reactiveButtons(snapshot: SmbRamSnapshot): ButtonName[] | undefined {
  if (snapshot.dying || snapshot.playerStateName.includes("transforming")) {
    return [];
  }

  if (snapshot.onVine) {
    return ["UP", "RIGHT"];
  }

  if (snapshot.enteringPipe || snapshot.changeAreaTimer > 0) {
    return ["DOWN", "RIGHT"];
  }

  return undefined;
}

function baselineButtons(frame: number, seed: number): ButtonName[] {
  if (frame < 20) {
    return [];
  }

  const buttons: ButtonName[] = ["B", "RIGHT"];
  const jitter = seed % 23;
  const cycle = (frame + jitter) % 170;
  if (cycle >= 55 && cycle <= 76) {
    buttons.push("A");
  }

  return buttons;
}

function glitchHunterButtons(frame: number, seed: number): ButtonName[] {
  const random = createSeededRandom(seed + 4042);
  const offset = Math.floor(random() * 30);
  const cycle = (frame + offset) % 900;

  if (frame < 15) {
    return [];
  }

  if (cycle < 150) {
    return jumpWindow(cycle, 52, 84, ["B", "RIGHT"]);
  }
  if (cycle < 230) {
    return ["B", "LEFT"];
  }
  if (cycle < 360) {
    return jumpWindow(cycle, 245, 282, ["B", "RIGHT"]);
  }
  if (cycle < 460) {
    return ["B", "DOWN", "RIGHT"];
  }
  if (cycle < 540) {
    return ["B", "RIGHT"];
  }
  if (cycle < 660) {
    return cycle % 34 < 17 ? ["B", "LEFT"] : ["B", "RIGHT"];
  }
  return jumpWindow(cycle, 705, 740, ["B", "RIGHT"]);
}

function completionistButtons(
  frame: number,
  snapshot: SmbRamSnapshot,
  durationFrames: number,
  seed: number
): ButtonName[] {
  const random = createSeededRandom(seed + 1337);
  const offset = Math.floor(random() * 40);
  const cycle = (frame + offset) % 540;

  if (frame > durationFrames * 0.75 && snapshot.pipeTileCount > 0) {
    return ["DOWN", "RIGHT"];
  }

  if (cycle < 90) {
    return jumpWindow(cycle, 22, 42, ["RIGHT"]);
  }
  if (cycle < 175) {
    return jumpWindow(cycle, 115, 132, ["B", "RIGHT"]);
  }
  if (cycle < 230) {
    return ["LEFT"];
  }
  if (cycle < 320) {
    return jumpWindow(cycle, 270, 295, ["RIGHT"]);
  }
  if (cycle < 390 && snapshot.pipeTileCount > 0) {
    return ["DOWN", "RIGHT"];
  }

  return jumpWindow(cycle, 430, 452, ["B", "RIGHT"]);
}

function jumpWindow(
  frame: number,
  start: number,
  end: number,
  base: ButtonName[]
): ButtonName[] {
  if (frame >= start && frame <= end) {
    return [...base, "A"];
  }
  return base;
}
