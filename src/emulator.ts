import { Controller, NES, type ButtonKey, type EmulatorData } from "jsnes";
import { hashFrameBuffer } from "./frame-hash.js";
import type { ButtonName } from "./types.js";

type NesWithCpu = NES & {
  cpu?: {
    mem?: Uint8Array;
  };
};

export type HeadlessNesCore = Pick<NES, "loadROM" | "fromJSON" | "toJSON" | "frame" | "buttonDown" | "buttonUp"> & {
  cpu?: {
    mem?: Uint8Array;
  };
};

const BUTTON_MAP: Record<ButtonName, ButtonKey> = {
  A: Controller.BUTTON_A,
  B: Controller.BUTTON_B,
  SELECT: Controller.BUTTON_SELECT,
  START: Controller.BUTTON_START,
  UP: Controller.BUTTON_UP,
  DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT,
  RIGHT: Controller.BUTTON_RIGHT
};

export class HeadlessNes {
  private readonly nes: HeadlessNesCore;
  private activeButtons = new Set<ButtonName>();
  private latestFrameHash = "no-frame";

  constructor(nes?: HeadlessNesCore) {
    this.nes =
      nes ??
      new NES({
        emulateSound: false,
        onFrame: (buffer) => {
          this.latestFrameHash = hashFrameBuffer(buffer);
        }
      });
  }

  load(romData: Uint8Array, state: unknown): void {
    this.nes.loadROM(romData);
    this.nes.fromJSON(state as EmulatorData);
    this.activeButtons.clear();
  }

  snapshot(): unknown {
    return cloneJson(this.nes.toJSON());
  }

  restore(state: unknown): void {
    this.nes.fromJSON(state as EmulatorData);
    this.activeButtons.clear();
    this.latestFrameHash = "no-frame";
  }

  step(buttons: Iterable<ButtonName>): void {
    this.setButtons(buttons);
    this.nes.frame();
  }

  getFrameHash(): string {
    return this.latestFrameHash;
  }

  getCpuMemory(): Uint8Array {
    const memory = (this.nes as NesWithCpu).cpu?.mem;
    if (!memory) {
      throw new Error("JSNES CPU memory is unavailable after loading the ROM/state.");
    }

    return memory;
  }

  private setButtons(buttons: Iterable<ButtonName>): void {
    const nextButtons = new Set(buttons);

    for (const button of this.activeButtons) {
      if (!nextButtons.has(button)) {
        this.nes.buttonUp(1, BUTTON_MAP[button]);
      }
    }

    for (const button of nextButtons) {
      if (!this.activeButtons.has(button)) {
        this.nes.buttonDown(1, BUTTON_MAP[button]);
      }
    }

    this.activeButtons = nextButtons;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
