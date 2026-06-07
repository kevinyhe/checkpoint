import { executeEpisode, sessionFromExecution } from "./episode.js";
import { HeadlessNes } from "./emulator.js";
import { readBinaryFile, readTextFile, sha1, createRunId } from "./files.js";
import { selectPersonaButtons } from "./personas.js";
import { decodeSmbRam, isWorld42 } from "./smb-ram.js";
import {
  SCRIPTED_PERSONAS,
  type PersonaOption,
  type RunOptions,
  type RunResult,
  type ScriptedPersona
} from "./types.js";

export interface ValidateStateResult {
  ok: boolean;
  game: "super-mario-bros-nes";
  expected: {
    world: 4;
    level: 2;
  };
  actual: {
    world: number;
    level: number;
    rawWorld: number;
    rawLevel: number;
    playerState: number;
    playerStateName: string;
    gameMode: number;
    levelLoading: number;
    progress: number;
  };
  romSha1: string;
  stateSha1: string;
}

export async function runPlaytest(options: RunOptions): Promise<RunResult> {
  const durationSeconds = normalizeDuration(options.durationSeconds);
  const seed = normalizeSeed(options.seed);
  const personaList = expandPersona(options.persona);
  const { romData, stateData, romSha1, stateSha1 } = await loadInputs(options.romPath, options.statePath);

  const sessions = personaList.map((persona, index) => {
    return runPersonaSession({
      persona,
      durationSeconds,
      seed: seed + index,
      romData,
      stateData
    });
  });

  return {
    run: {
      id: createRunId([romSha1, stateSha1, String(durationSeconds), String(seed), options.persona]),
      game: "super-mario-bros-nes",
      objective: "world-4-2-known-glitches",
      durationSeconds,
      seed,
      romSha1,
      stateSha1
    },
    sessions
  };
}

export async function validateState(romPath: string, statePath: string): Promise<ValidateStateResult> {
  const { romData, stateData, romSha1, stateSha1 } = await loadInputs(romPath, statePath);
  const emulator = new HeadlessNes();
  emulator.load(romData, cloneJson(stateData));
  const snapshot = decodeSmbRam(emulator.getCpuMemory());

  return {
    ok: isWorld42(snapshot),
    game: "super-mario-bros-nes",
    expected: {
      world: 4,
      level: 2
    },
    actual: {
      world: snapshot.world,
      level: snapshot.level,
      rawWorld: snapshot.rawWorld,
      rawLevel: snapshot.rawLevel,
      playerState: snapshot.playerState,
      playerStateName: snapshot.playerStateName,
      gameMode: snapshot.gameMode,
      levelLoading: snapshot.levelLoading,
      progress: snapshot.progress
    },
    romSha1,
    stateSha1
  };
}

function runPersonaSession(options: {
  persona: ScriptedPersona;
  durationSeconds: number;
  seed: number;
  romData: Uint8Array;
  stateData: unknown;
}) {
  const durationFrames = options.durationSeconds * 60;
  const execution = executeEpisode({
    romData: options.romData,
    stateData: options.stateData,
    durationFrames,
    selectButtons: (frame, snapshot) => {
      return selectPersonaButtons(options.persona, frame, snapshot, durationFrames, options.seed);
    }
  });

  return sessionFromExecution(options.persona, execution);
}

async function loadInputs(romPath: string, statePath: string) {
  const romData = await readBinaryFile(romPath, "ROM");
  const stateText = await readTextFile(statePath, "Save state");
  let stateData: unknown;

  try {
    stateData = JSON.parse(stateText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Save state file is not valid JSON: ${message}`);
  }

  return {
    romData,
    stateData,
    romSha1: sha1(romData),
    stateSha1: sha1(stateText)
  };
}

function expandPersona(persona: PersonaOption): ScriptedPersona[] {
  if (persona === "all") {
    return [...SCRIPTED_PERSONAS];
  }

  return [persona];
}

function normalizeDuration(durationSeconds: number): number {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Duration must be a positive whole number of seconds, received ${durationSeconds}.`);
  }
  return durationSeconds;
}

function normalizeSeed(seed: number): number {
  if (!Number.isInteger(seed)) {
    throw new Error(`Seed must be a whole number, received ${seed}.`);
  }
  return seed;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
