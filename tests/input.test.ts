import { describe, expect, it } from "vitest";
import { InputRecorder, mergeInputRanges, sliceInputRanges } from "../src/input.js";

describe("InputRecorder", () => {
  it("compresses stable button states into deterministic ranges", () => {
    const recorder = new InputRecorder();

    recorder.record(1, ["RIGHT", "B"]);
    recorder.record(2, ["B", "RIGHT"]);
    recorder.record(3, ["RIGHT", "B", "A"]);
    recorder.record(4, []);

    expect(recorder.finish(4)).toEqual([
      { frameStart: 1, frameEnd: 2, buttons: ["B", "RIGHT"] },
      { frameStart: 3, frameEnd: 3, buttons: ["A", "B", "RIGHT"] },
      { frameStart: 4, frameEnd: 4, buttons: [] }
    ]);
  });
});

describe("sliceInputRanges", () => {
  it("clips repro ranges to the requested evidence window", () => {
    const ranges = [
      { frameStart: 1, frameEnd: 10, buttons: ["RIGHT"] as const },
      { frameStart: 11, frameEnd: 20, buttons: ["A", "RIGHT"] as const }
    ];

    expect(sliceInputRanges(ranges, 8, 12)).toEqual([
      { frameStart: 8, frameEnd: 10, buttons: ["RIGHT"] },
      { frameStart: 11, frameEnd: 12, buttons: ["A", "RIGHT"] }
    ]);
  });
});

describe("mergeInputRanges", () => {
  it("concatenates checkpoint prefixes and suffixes into compact replay inputs", () => {
    expect(
      mergeInputRanges(
        [
          { frameStart: 1, frameEnd: 20, buttons: ["B", "RIGHT"] },
          { frameStart: 21, frameEnd: 30, buttons: ["A", "B", "RIGHT"] }
        ],
        [
          { frameStart: 31, frameEnd: 40, buttons: ["A", "B", "RIGHT"] },
          { frameStart: 41, frameEnd: 50, buttons: ["B", "RIGHT"] }
        ]
      )
    ).toEqual([
      { frameStart: 1, frameEnd: 20, buttons: ["B", "RIGHT"] },
      { frameStart: 21, frameEnd: 40, buttons: ["A", "B", "RIGHT"] },
      { frameStart: 41, frameEnd: 50, buttons: ["B", "RIGHT"] }
    ]);
  });
});
