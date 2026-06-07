import { describe, expect, it } from "vitest";
import { HeadlessNes, type HeadlessNesCore } from "../src/emulator.js";

describe("HeadlessNes checkpoints", () => {
  it("captures and restores cloned JSNES state snapshots", () => {
    const fake = createFakeCore();
    const emulator = new HeadlessNes(fake);

    emulator.load(new Uint8Array([1, 2, 3]), { marker: "start" });
    const snapshot = emulator.snapshot() as { marker: string };
    snapshot.marker = "mutated";

    expect(fake.state).toEqual({ marker: "start" });

    emulator.restore({ marker: "checkpoint" });

    expect(fake.state).toEqual({ marker: "checkpoint" });
  });
});

function createFakeCore(): HeadlessNesCore & { state: unknown } {
  return {
    state: {},
    cpu: {
      mem: new Uint8Array(0x800)
    },
    loadROM: () => undefined,
    fromJSON(state: unknown) {
      this.state = state;
    },
    toJSON() {
      return this.state;
    },
    frame: () => undefined,
    buttonDown: () => undefined,
    buttonUp: () => undefined
  } as HeadlessNesCore & { state: unknown };
}
