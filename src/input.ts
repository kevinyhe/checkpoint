import { BUTTON_NAMES, type ButtonName, type ReproInputRange } from "./types.js";

const BUTTON_ORDER = new Map<ButtonName, number>(
  BUTTON_NAMES.map((button, index) => [button, index])
);

export function normalizeButtons(buttons: Iterable<ButtonName>): ButtonName[] {
  return [...new Set(buttons)].sort((a, b) => {
    return (BUTTON_ORDER.get(a) ?? 99) - (BUTTON_ORDER.get(b) ?? 99);
  });
}

export function buttonKey(buttons: Iterable<ButtonName>): string {
  return normalizeButtons(buttons).join("+");
}

export class InputRecorder {
  private readonly ranges: ReproInputRange[] = [];
  private current?: ReproInputRange;

  record(frame: number, buttons: Iterable<ButtonName>): void {
    const normalized = normalizeButtons(buttons);
    const nextKey = buttonKey(normalized);
    const currentKey = this.current ? buttonKey(this.current.buttons) : undefined;

    if (this.current && currentKey === nextKey) {
      this.current.frameEnd = frame;
      return;
    }

    if (this.current) {
      this.ranges.push(this.current);
    }

    this.current = {
      frameStart: frame,
      frameEnd: frame,
      buttons: normalized
    };
  }

  finish(finalFrame: number): ReproInputRange[] {
    if (this.current) {
      this.current.frameEnd = Math.max(this.current.frameEnd, finalFrame);
      this.ranges.push(this.current);
      this.current = undefined;
    }

    return this.ranges.map((range) => ({ ...range, buttons: [...range.buttons] }));
  }

  snapshot(finalFrame?: number): ReproInputRange[] {
    const ranges = this.ranges.map((range) => ({ ...range, buttons: [...range.buttons] }));
    if (this.current) {
      ranges.push({
        ...this.current,
        frameEnd: finalFrame === undefined ? this.current.frameEnd : Math.max(this.current.frameEnd, finalFrame),
        buttons: [...this.current.buttons]
      });
    }
    return ranges;
  }
}

export function sliceInputRanges(
  ranges: ReproInputRange[],
  frameStart: number,
  frameEnd: number
): ReproInputRange[] {
  return ranges
    .filter((range) => range.frameEnd >= frameStart && range.frameStart <= frameEnd)
    .map((range) => ({
      frameStart: Math.max(range.frameStart, frameStart),
      frameEnd: Math.min(range.frameEnd, frameEnd),
      buttons: [...range.buttons]
    }));
}

export function mergeInputRanges(...rangeSets: ReproInputRange[][]): ReproInputRange[] {
  const sorted = rangeSets
    .flat()
    .filter((range) => range.frameEnd >= range.frameStart)
    .map((range) => ({
      frameStart: Math.floor(range.frameStart),
      frameEnd: Math.floor(range.frameEnd),
      buttons: normalizeButtons(range.buttons)
    }))
    .sort((a, b) => a.frameStart - b.frameStart || a.frameEnd - b.frameEnd);
  const merged: ReproInputRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.frameEnd + 1 >= range.frameStart && buttonKey(previous.buttons) === buttonKey(range.buttons)) {
      previous.frameEnd = Math.max(previous.frameEnd, range.frameEnd);
      continue;
    }

    merged.push({ ...range, buttons: [...range.buttons] });
  }

  return merged;
}
