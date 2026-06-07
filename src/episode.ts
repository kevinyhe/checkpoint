import { analyzeSession } from "./detectors.js";
import { HeadlessNes } from "./emulator.js";
import { InputRecorder, mergeInputRanges, sliceInputRanges } from "./input.js";
import { decodeSmbRam } from "./smb-ram.js";
import type {
  ButtonName,
  Finding,
  FrameSample,
  Persona,
  ReproInputRange,
  SessionResult,
  SmbRamSnapshot
} from "./types.js";

export interface EpisodeExecutionOptions {
  romData: Uint8Array;
  stateData: unknown;
  durationFrames: number;
  startFrame?: number;
  prefixReplayInputs?: ReproInputRange[];
  stopOnDeath?: boolean;
  selectButtons: (
    frame: number,
    snapshot: SmbRamSnapshot,
    durationFrames: number
  ) => ButtonName[];
  onSample?: (context: EpisodeSampleContext) => void;
}

export interface EpisodeSampleContext {
  sample: FrameSample;
  localFrame: number;
  globalFrame: number;
  captureState: () => unknown;
  replayInputs: () => ReproInputRange[];
}

export interface EpisodeExecution {
  samples: FrameSample[];
  replayInputs: ReproInputRange[];
  emulatorError?: {
    frame: number;
    message: string;
  };
}

export function executeEpisode(options: EpisodeExecutionOptions): EpisodeExecution {
  const emulator = new HeadlessNes();
  emulator.load(options.romData, cloneJson(options.stateData));

  const samples: FrameSample[] = [];
  const inputRecorder = new InputRecorder();
  const startFrame = options.startFrame ?? 0;
  const prefixReplayInputs = options.prefixReplayInputs ?? [];
  let snapshot = decodeSmbRam(emulator.getCpuMemory());
  const initialLives = snapshot.lives;
  let finalFrame = 0;

  for (let frame = 1; frame <= options.durationFrames; frame += 1) {
    const globalFrame = startFrame + frame;
    try {
      const buttons = options.selectButtons(frame, snapshot, options.durationFrames);
      inputRecorder.record(globalFrame, buttons);
      emulator.step(buttons);
      snapshot = decodeSmbRam(emulator.getCpuMemory());
      const sample = {
        frame: globalFrame,
        frameHash: emulator.getFrameHash(),
        ...snapshot
      };
      samples.push(sample);
      finalFrame = globalFrame;
      options.onSample?.({
        sample,
        localFrame: frame,
        globalFrame,
        captureState: () => emulator.snapshot(),
        replayInputs: () => mergeInputRanges(prefixReplayInputs, inputRecorder.snapshot(globalFrame))
      });
      if (options.stopOnDeath && isDeathStarted(sample, initialLives)) {
        break;
      }
    } catch (error) {
      return {
        samples,
        replayInputs: mergeInputRanges(prefixReplayInputs, inputRecorder.finish(Math.max(finalFrame, globalFrame))),
        emulatorError: {
          frame: globalFrame,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  return {
    samples,
    replayInputs: mergeInputRanges(prefixReplayInputs, inputRecorder.finish(finalFrame || startFrame + options.durationFrames))
  };
}

export function sessionFromExecution(
  persona: Persona,
  execution: EpisodeExecution,
  extraFindings: Finding[] = []
): SessionResult {
  const findings = [...extraFindings];
  if (execution.emulatorError) {
    findings.push(createEmulatorErrorFinding(execution.emulatorError, execution.replayInputs));
  }

  const session = analyzeSession(persona, execution.samples, execution.replayInputs, findings);
  const replayFrameEnd = execution.replayInputs.at(-1)?.frameEnd ?? session.metrics.frames;
  if (replayFrameEnd > session.metrics.frames) {
    session.metrics.frames = replayFrameEnd;
    session.metrics.gameSeconds = Number((replayFrameEnd / 60).toFixed(2));
  }
  return session;
}

export function createEmulatorErrorFinding(
  error: { frame: number; message: string },
  inputRanges: ReproInputRange[]
): Finding {
  const frameStart = Math.max(1, error.frame - 120);
  const frameEnd = error.frame;

  return {
    type: "emulator-error",
    severity: "high",
    frameStart,
    frameEnd,
    summary: `The emulator threw while executing the episode: ${error.message}`,
    evidence: {
      frame: error.frame,
      message: error.message
    },
    reproInputs: sliceInputRanges(inputRanges, frameStart, frameEnd)
  };
}

function isDeathStarted(sample: SmbRamSnapshot, initialLives: number): boolean {
  return (
    sample.dying ||
    sample.playerStateName === "player-dies" ||
    sample.playerStateName === "dying" ||
    sample.deathMusicLoaded !== 0 ||
    sample.lives < initialLives
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
