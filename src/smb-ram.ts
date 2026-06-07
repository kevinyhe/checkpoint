import type { SmbRamSnapshot } from "./types.js";

export const SMB_RAM = {
  playerState: 0x000e,
  enemyTypes: 0x0016,
  powerupDrawn: 0x0014,
  playerFloatState: 0x001d,
  powerupState: 0x0023,
  powerupType: 0x0039,
  horizontalSpeed: 0x0057,
  levelPage: 0x006d,
  xOnScreen: 0x0086,
  verticalVelocity: 0x009f,
  yOnScreen: 0x00ce,
  areaMusic: 0x00fb,
  eventMusic: 0x00fc,
  soundEffect1: 0x00fd,
  soundEffect2: 0x00fe,
  soundEffect3: 0x00ff,
  tileBase: 0x0500,
  tileEnd: 0x069f,
  warpZoneControl: 0x06d6,
  changeAreaTimer: 0x06de,
  horizontalSpeedAbs: 0x0700,
  deathMusicLoaded: 0x0712,
  currentScreen: 0x071a,
  nextScreen: 0x071b,
  playerScrollX: 0x071d,
  playerHitDetectFlag: 0x0722,
  scrollLock: 0x0723,
  areaOffset: 0x0750,
  levelEntry: 0x0752,
  powerupLevel: 0x0756,
  lives: 0x075a,
  preLevel: 0x075e,
  world: 0x075f,
  level: 0x0760,
  gameMode: 0x0770,
  levelLoading: 0x0772,
  scrollAmount: 0x0775,
  playerCollisionBits: 0x0490,
  enemyCollisionBits: 0x0491,
  scoreStart: 0x07dd,
  scoreEnd: 0x07e2,
  gameTimerHundreds: 0x07f8,
  gameTimerTens: 0x07f9,
  gameTimerOnes: 0x07fa
} as const;

const PLAYER_STATES = new Map<number, string>([
  [0x00, "left-edge"],
  [0x01, "climbing-vine"],
  [0x02, "entering-reversed-l-pipe"],
  [0x03, "going-down-pipe"],
  [0x04, "autowalk"],
  [0x05, "autowalk"],
  [0x06, "player-dies"],
  [0x07, "entering-area"],
  [0x08, "normal"],
  [0x09, "small-to-large"],
  [0x0a, "large-to-small"],
  [0x0b, "dying"],
  [0x0c, "to-fire-mario"]
]);

const VINE_TILES = new Set([0x08, 0x26, 0x56]);
const PIPE_TILES = new Set([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21]);
const HIDDEN_BLOCK_TILES = new Set([0x5f]);

export function decodeSmbRam(memory: Uint8Array): SmbRamSnapshot {
  const enemyTypes = readBytes(memory, SMB_RAM.enemyTypes, 5);
  const playerState = readByte(memory, SMB_RAM.playerState);
  const soundEffect2 = readByte(memory, SMB_RAM.soundEffect2);
  const soundEffect3 = readByte(memory, SMB_RAM.soundEffect3);
  const eventMusic = readByte(memory, SMB_RAM.eventMusic);
  const deathMusicLoaded = readByte(memory, SMB_RAM.deathMusicLoaded);
  const currentScreen = readByte(memory, SMB_RAM.currentScreen);
  const xOnScreen = readByte(memory, SMB_RAM.xOnScreen);
  const levelPage = readByte(memory, SMB_RAM.levelPage);
  const vineTileCount = countTiles(memory, VINE_TILES);
  const pipeTileCount = countTiles(memory, PIPE_TILES);
  const hiddenBlockTileCount = countTiles(memory, HIDDEN_BLOCK_TILES);
  const warpZoneControl = readByte(memory, SMB_RAM.warpZoneControl);

  const onVine = playerState === 0x01;
  const enteringPipe = playerState === 0x02 || playerState === 0x03 || (soundEffect3 & 0x10) !== 0;
  const dying = playerState === 0x06 || playerState === 0x0b || deathMusicLoaded !== 0 || (eventMusic & 0x01) !== 0;
  const vineVisible = onVine || enemyTypes.includes(0x2f) || (soundEffect2 & 0x04) !== 0 || vineTileCount > 0;
  const warpZoneVisible = enemyTypes.includes(0x34) || warpZoneControl !== 0;
  const pipeInteraction = enteringPipe || readByte(memory, SMB_RAM.changeAreaTimer) !== 0 || pipeTileCount > 0;

  const rawWorld = readByte(memory, SMB_RAM.world);
  const rawLevel = readByte(memory, SMB_RAM.level);
  const areaOffset = readByte(memory, SMB_RAM.areaOffset);
  const areaMusic = readByte(memory, SMB_RAM.areaMusic);
  const levelEntry = readByte(memory, SMB_RAM.levelEntry);

  return {
    rawWorld,
    rawLevel,
    world: rawWorld + 1,
    level: rawLevel + 1,
    playerState,
    playerStateName: PLAYER_STATES.get(playerState) ?? `unknown-${playerState}`,
    playerFloatState: readByte(memory, SMB_RAM.playerFloatState),
    currentScreen,
    nextScreen: readByte(memory, SMB_RAM.nextScreen),
    xOnScreen,
    yOnScreen: readByte(memory, SMB_RAM.yOnScreen),
    levelPage,
    progress: levelPage * 256 + xOnScreen,
    horizontalSpeed: toSignedByte(readByte(memory, SMB_RAM.horizontalSpeed)),
    horizontalSpeedAbs: readByte(memory, SMB_RAM.horizontalSpeedAbs),
    verticalVelocity: toSignedByte(readByte(memory, SMB_RAM.verticalVelocity)),
    lives: readByte(memory, SMB_RAM.lives),
    coins: readByte(memory, SMB_RAM.preLevel),
    score: readScore(memory),
    gameTimer: readGameTimer(memory),
    gameMode: readByte(memory, SMB_RAM.gameMode),
    levelLoading: readByte(memory, SMB_RAM.levelLoading),
    levelEntry,
    scrollLock: readByte(memory, SMB_RAM.scrollLock),
    scrollAmount: readByte(memory, SMB_RAM.scrollAmount),
    areaOffset,
    areaMusic,
    eventMusic,
    soundEffect1: readByte(memory, SMB_RAM.soundEffect1),
    soundEffect2,
    soundEffect3,
    playerCollisionBits: readByte(memory, SMB_RAM.playerCollisionBits),
    enemyCollisionBits: readByte(memory, SMB_RAM.enemyCollisionBits),
    playerHitDetectFlag: readByte(memory, SMB_RAM.playerHitDetectFlag),
    warpZoneControl,
    changeAreaTimer: readByte(memory, SMB_RAM.changeAreaTimer),
    deathMusicLoaded,
    preLevel: readByte(memory, SMB_RAM.preLevel),
    powerupDrawn: readByte(memory, SMB_RAM.powerupDrawn),
    powerupState: readByte(memory, SMB_RAM.powerupState),
    powerupType: readByte(memory, SMB_RAM.powerupType),
    enemyTypes,
    vineTileCount,
    pipeTileCount,
    hiddenBlockTileCount,
    onVine,
    enteringPipe,
    dying,
    vineVisible,
    warpZoneVisible,
    pipeInteraction,
    roomId: createRoomId(rawWorld, rawLevel, areaOffset, areaMusic, levelEntry)
  };
}

export function isWorld42(snapshot: Pick<SmbRamSnapshot, "world" | "level">): boolean {
  return snapshot.world === 4 && snapshot.level === 2;
}

export function readByte(memory: Uint8Array, address: number): number {
  return memory[address & 0x07ff] ?? 0;
}

function readBytes(memory: Uint8Array, address: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => readByte(memory, address + offset));
}

function countTiles(memory: Uint8Array, tileSet: ReadonlySet<number>): number {
  let count = 0;
  for (let address = SMB_RAM.tileBase; address <= SMB_RAM.tileEnd; address += 1) {
    if (tileSet.has(readByte(memory, address))) {
      count += 1;
    }
  }
  return count;
}

function readGameTimer(memory: Uint8Array): number {
  return (
    digit(readByte(memory, SMB_RAM.gameTimerHundreds)) * 100 +
    digit(readByte(memory, SMB_RAM.gameTimerTens)) * 10 +
    digit(readByte(memory, SMB_RAM.gameTimerOnes))
  );
}

function readScore(memory: Uint8Array): number {
  const placeValues = [1_000_000, 100_000, 10_000, 1_000, 100, 10];
  return placeValues.reduce((score, placeValue, offset) => score + digit(readByte(memory, SMB_RAM.scoreStart + offset)) * placeValue, 0);
}

function createRoomId(rawWorld: number, rawLevel: number, areaOffset: number, areaMusic: number, levelEntry: number): string {
  return `w${rawWorld + 1}-${rawLevel + 1}|a${areaOffset}|m${areaMusic}|e${levelEntry}`;
}

function digit(value: number): number {
  return value & 0x0f;
}

function toSignedByte(value: number): number {
  return value >= 0x80 ? value - 0x100 : value;
}
