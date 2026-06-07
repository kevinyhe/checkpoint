import { BUTTON_NAMES, type ButtonName, type ReproInputRange } from "./types.js";

const VALID_BUTTONS = new Set<string>(BUTTON_NAMES);

export function buttonsForFrame(ranges: ReproInputRange[] | undefined, frame: number): ButtonName[] {
  if (!ranges || !Number.isInteger(frame) || frame < 1) {
    return [];
  }

  const range = ranges.find((candidate) => candidate.frameStart <= frame && candidate.frameEnd >= frame);
  if (!range) {
    return [];
  }

  return range.buttons.filter((button): button is ButtonName => VALID_BUTTONS.has(button));
}

export function hasReplayInputs(value: unknown): value is { replayInputs: ReproInputRange[] } {
  if (!value || typeof value !== "object" || !("replayInputs" in value)) {
    return false;
  }

  const candidate = (value as { replayInputs?: unknown }).replayInputs;
  return Array.isArray(candidate);
}
