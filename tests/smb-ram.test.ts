import { describe, expect, it } from "vitest";
import { decodeSmbRam, isWorld42, SMB_RAM } from "../src/smb-ram.js";

describe("decodeSmbRam", () => {
  it("normalizes world, level, progress, timer, and signed movement fields", () => {
    const memory = new Uint8Array(0x800);
    memory[SMB_RAM.world] = 3;
    memory[SMB_RAM.level] = 1;
    memory[SMB_RAM.currentScreen] = 2;
    memory[SMB_RAM.levelPage] = 2;
    memory[SMB_RAM.xOnScreen] = 64;
    memory[SMB_RAM.horizontalSpeed] = 0xf8;
    memory[SMB_RAM.horizontalSpeedAbs] = 8;
    memory[SMB_RAM.verticalVelocity] = 0x05;
    memory[SMB_RAM.gameTimerHundreds] = 3;
    memory[SMB_RAM.gameTimerTens] = 2;
    memory[SMB_RAM.gameTimerOnes] = 1;
    memory[SMB_RAM.scoreStart] = 0;
    memory[SMB_RAM.scoreStart + 1] = 1;
    memory[SMB_RAM.scoreStart + 2] = 2;
    memory[SMB_RAM.scoreStart + 3] = 3;
    memory[SMB_RAM.scoreStart + 4] = 4;
    memory[SMB_RAM.scoreStart + 5] = 5;
    memory[SMB_RAM.areaOffset] = 7;
    memory[SMB_RAM.areaMusic] = 4;
    memory[SMB_RAM.levelEntry] = 2;

    const snapshot = decodeSmbRam(memory);

    expect(snapshot.world).toBe(4);
    expect(snapshot.level).toBe(2);
    expect(snapshot.progress).toBe(576);
    expect(snapshot.horizontalSpeed).toBe(-8);
    expect(snapshot.horizontalSpeedAbs).toBe(8);
    expect(snapshot.verticalVelocity).toBe(5);
    expect(snapshot.gameTimer).toBe(321);
    expect(snapshot.score).toBe(123450);
    expect(snapshot.roomId).toBe("w4-2|a7|m4|e2");
    expect(isWorld42(snapshot)).toBe(true);
  });

  it("detects vine, pipe, warp, collision, and death probes", () => {
    const memory = new Uint8Array(0x800);
    memory[SMB_RAM.playerState] = 0x01;
    memory[SMB_RAM.enemyTypes] = 0x2f;
    memory[SMB_RAM.enemyTypes + 1] = 0x34;
    memory[SMB_RAM.soundEffect2] = 0x04;
    memory[SMB_RAM.soundEffect3] = 0x10;
    memory[SMB_RAM.warpZoneControl] = 4;
    memory[SMB_RAM.changeAreaTimer] = 12;
    memory[SMB_RAM.playerCollisionBits] = 0xfe;
    memory[SMB_RAM.enemyCollisionBits] = 0x01;
    memory[SMB_RAM.deathMusicLoaded] = 1;
    memory[0x0500] = 0x56;
    memory[0x0501] = 0x10;
    memory[0x0502] = 0x5f;

    const snapshot = decodeSmbRam(memory);

    expect(snapshot.onVine).toBe(true);
    expect(snapshot.vineVisible).toBe(true);
    expect(snapshot.enteringPipe).toBe(true);
    expect(snapshot.pipeInteraction).toBe(true);
    expect(snapshot.warpZoneVisible).toBe(true);
    expect(snapshot.dying).toBe(true);
    expect(snapshot.playerCollisionBits).toBe(0xfe);
    expect(snapshot.enemyCollisionBits).toBe(1);
    expect(snapshot.vineTileCount).toBe(1);
    expect(snapshot.pipeTileCount).toBe(1);
    expect(snapshot.hiddenBlockTileCount).toBe(1);
  });
});
