declare module "jsnes" {
  export type ButtonKey = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  export type ControllerId = 1 | 2;

  export interface EmulatorData {
    cpu: object;
    mmap: object;
    ppu: object;
    papu: object;
  }

  export interface NESOptions {
    onFrame?: (buffer: Uint32Array) => void;
    onAudioSample?: (left: number, right: number) => void;
    onStatusUpdate?: (status: string) => void;
    onBatteryRamWrite?: (address: number, value: number) => void;
    emulateSound?: boolean;
    sampleRate?: number;
  }

  export class NES {
    constructor(opts: NESOptions);
    frame(): void;
    buttonDown(controller: ControllerId, button: ButtonKey): void;
    buttonUp(controller: ControllerId, button: ButtonKey): void;
    loadROM(data: string | Buffer | Uint8Array | ArrayBuffer): void;
    fromJSON(data: EmulatorData): void;
    toJSON(): EmulatorData;
  }

  export class Controller {
    static readonly BUTTON_A: 0;
    static readonly BUTTON_B: 1;
    static readonly BUTTON_SELECT: 2;
    static readonly BUTTON_START: 3;
    static readonly BUTTON_UP: 4;
    static readonly BUTTON_DOWN: 5;
    static readonly BUTTON_LEFT: 6;
    static readonly BUTTON_RIGHT: 7;
    static readonly BUTTON_TURBO_A: 8;
    static readonly BUTTON_TURBO_B: 9;
  }
}
