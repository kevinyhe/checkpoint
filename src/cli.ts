#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { runDiscovery } from "./discovery.js";
import { writeJsonFile } from "./files.js";
import { runPlaytest, validateState } from "./runner.js";
import {
  SCRIPTED_PERSONAS,
  type BugTarget,
  type DiscoveryFocus,
  type DiscoveryProgressEvent,
  type DiscoveryStrategy,
  type PersonaOption
} from "./types.js";
import { startRunViewerServer } from "./viewer-server.js";

const program = new Command();

program
  .name("playtestiq-smb")
  .description("PlaytestIQ SMB 4-2 scripted AI playtesting CLI demo.")
  .version("0.1.0");

program
  .command("run")
  .description("Run scripted playtest personas against a user-supplied SMB ROM and JSNES save state.")
  .requiredOption("--rom <file.nes>", "Path to a legally provided Super Mario Bros. NES ROM.")
  .requiredOption("--state <state.json>", "Path to a JSNES toJSON() save state positioned at World 4-2.")
  .option("--persona <persona>", "glitch-hunter, baseline, completionist, or all.", parsePersona, "all")
  .option("--duration <seconds>", "Run budget per persona in seconds.", parsePositiveInteger, 120)
  .option("--seed <number>", "Deterministic persona seed.", parseInteger, 1)
  .option("--out <result.json>", "Write JSON results to this path. Defaults to stdout.")
  .action(async (options: RunCommandOptions) => {
    const result = await runPlaytest({
      romPath: options.rom,
      statePath: options.state,
      persona: options.persona,
      durationSeconds: options.duration,
      seed: options.seed,
      outPath: options.out
    });

    if (options.out) {
      await writeJsonFile(options.out, result);
      return;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("validate-state")
  .description("Validate that a ROM and JSNES save state load and normalize to World 4-2.")
  .requiredOption("--rom <file.nes>", "Path to a legally provided Super Mario Bros. NES ROM.")
  .requiredOption("--state <state.json>", "Path to a JSNES toJSON() save state positioned at World 4-2.")
  .action(async (options: ValidateCommandOptions) => {
    const result = await validateState(options.rom, options.state);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("discover")
  .description("Run coverage-guided bug-finding exploration against SMB World 4-2.")
  .requiredOption("--rom <file.nes>", "Path to a legally provided Super Mario Bros. NES ROM.")
  .requiredOption("--state <state.json>", "Path to a JSNES toJSON() save state positioned at World 4-2.")
  .option("--episodes <count>", "Number of exploration episodes to run.", parsePositiveInteger, 200)
  .option("--episode-duration <seconds>", "Run budget per discovery episode in seconds.", parsePositiveInteger, 45)
  .option("--seed <number>", "Deterministic discovery seed.", parseInteger, 1)
  .option("--top <count>", "Number of top episodes to keep in the output JSON.", parsePositiveInteger, 10)
  .option("--workers <count>", "Number of parallel discovery worker shards.", parsePositiveInteger, 1)
  .option("--strategy <strategy>", "full-run-evolution, go-explore, or trace-mutation.", parseDiscoveryStrategy, "full-run-evolution")
  .option("--focus <focus>", "balanced, bugs, progress, or coverage.", parseDiscoveryFocus, "balanced")
  .option("--bug-target <target>", "all, warp-zone, or wall-clip.", parseBugTarget, "all")
  .option("--checkpoint-limit <count>", "Requested in-memory Go-Explore checkpoints per worker; capped for heap safety.", parsePositiveInteger, 160)
  .option("--route-seed", "Seed Go-Explore with the RAM-feedback 4-2 progress controller.", true)
  .option("--no-route-seed", "Disable the initial route-seed controller episode.")
  .option("--save-all", "Write every discovery episode to a compact JSONL sidecar for synced overlay review.", false)
  .option("--episode-log <file.jsonl>", "Write every discovery episode to this JSONL sidecar path.")
  .option("--no-progress", "Disable stderr progress output.")
  .option("--out <result.json>", "Write JSON results to this path. Defaults to stdout.")
  .action(async (options: DiscoverCommandOptions) => {
    const reportProgress = options.progress ? createDiscoveryProgressReporter() : undefined;
    const result = await runDiscovery({
      romPath: options.rom,
      statePath: options.state,
      episodes: options.episodes,
      episodeDurationSeconds: options.episodeDuration,
      seed: options.seed,
      top: options.top,
      outPath: options.out,
      workers: options.workers,
      progress: options.progress,
      strategy: options.strategy,
      focus: options.focus,
      bugTarget: options.bugTarget,
      checkpointLimit: options.checkpointLimit,
      routeSeed: options.routeSeed,
      saveAll: options.saveAll,
      episodeLogPath: options.episodeLog,
      onProgress: reportProgress
    });

    if (options.out) {
      await writeJsonFile(options.out, result);
      return;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("view")
  .description("Start a local browser viewer that replays a run JSON inside JSNES.")
  .requiredOption("--rom <file.nes>", "Path to the same legally provided SMB ROM used for the run.")
  .requiredOption("--state <state.json>", "Path to the same JSNES 4-2 save state used for the run.")
  .requiredOption("--run <result.json>", "Path to a PlaytestIQ run JSON.")
  .option("--episodes <file.jsonl>", "Optional all-episode JSONL sidecar for synced overlay mode.")
  .option("--port <number>", "Preferred local viewer port.", parsePositiveInteger, 4174)
  .action(async (options: ViewCommandOptions) => {
    const viewer = await startRunViewerServer({
      romPath: options.rom,
      statePath: options.state,
      runPath: options.run,
      episodesPath: options.episodes,
      port: options.port
    });

    process.stdout.write(`Run viewer: ${viewer.url}\n`);
    process.stdout.write("Press Ctrl+C to stop the viewer.\n");

    await waitForShutdown();
    await new Promise<void>((resolve) => viewer.server.close(() => resolve()));
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const commandError = error as { code?: string; exitCode?: number; message?: string };
  if (commandError.code === "commander.helpDisplayed" || commandError.code === "commander.version") {
    process.exit(0);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(commandError.exitCode ?? 1);
}

interface RunCommandOptions {
  rom: string;
  state: string;
  persona: PersonaOption;
  duration: number;
  seed: number;
  out?: string;
}

interface ValidateCommandOptions {
  rom: string;
  state: string;
}

interface DiscoverCommandOptions {
  rom: string;
  state: string;
  episodes: number;
  episodeDuration: number;
  seed: number;
  top: number;
  workers: number;
  strategy: DiscoveryStrategy;
  focus: DiscoveryFocus;
  bugTarget: BugTarget;
  checkpointLimit: number;
  routeSeed: boolean;
  saveAll: boolean;
  episodeLog?: string;
  progress: boolean;
  out?: string;
}

interface ViewCommandOptions {
  rom: string;
  state: string;
  run: string;
  episodes?: string;
  port: number;
}

function parsePersona(value: string): PersonaOption {
  const allowed = new Set<string>([...SCRIPTED_PERSONAS, "all"]);
  if (!allowed.has(value)) {
    throw new InvalidArgumentError(`Invalid persona "${value}". Expected one of: ${[...allowed].join(", ")}.`);
  }
  return value as PersonaOption;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive whole number.");
  }
  return parsed;
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("Value must be a whole number.");
  }
  return parsed;
}

function parseDiscoveryStrategy(value: string): DiscoveryStrategy {
  if (value !== "full-run-evolution" && value !== "go-explore" && value !== "trace-mutation") {
    throw new InvalidArgumentError(`Invalid strategy "${value}". Expected full-run-evolution, go-explore, or trace-mutation.`);
  }

  return value;
}

function parseDiscoveryFocus(value: string): DiscoveryFocus {
  if (value !== "balanced" && value !== "bugs" && value !== "progress" && value !== "coverage") {
    throw new InvalidArgumentError(`Invalid focus "${value}". Expected balanced, bugs, progress, or coverage.`);
  }

  return value;
}

function parseBugTarget(value: string): BugTarget {
  if (value !== "all" && value !== "warp-zone" && value !== "wall-clip") {
    throw new InvalidArgumentError(`Invalid bug target "${value}". Expected all, warp-zone, or wall-clip.`);
  }

  return value;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function createDiscoveryProgressReporter(): (event: DiscoveryProgressEvent) => void {
  const completed = new Set<number>();
  let bestScore = 0;
  let lastLineLength = 0;

  return (event) => {
    if (event.type === "episode") {
      completed.add(event.episode);
      bestScore = Math.max(bestScore, event.bestScore ?? event.score ?? 0);
    } else if (event.type === "complete") {
      bestScore = Math.max(bestScore, event.bestScore ?? 0);
    }

    const done = event.type === "complete" ? event.episodes : completed.size;
    const elapsedSeconds = Math.max(0.01, event.elapsedMs / 1000);
    const rate = done / elapsedSeconds;
    const remaining = Math.max(0, event.episodes - done);
    const etaSeconds = rate > 0 ? remaining / rate : 0;
    const workerLabel = event.workerIndex >= 0 ? `w${event.workerIndex + 1}/${event.workers}` : `${event.workers} workers`;
    const line = `[discover] ${done}/${event.episodes} episodes (${workerLabel}) | best ${bestScore.toFixed(2)} | latest ${(
      event.score ?? 0
    ).toFixed(2)} | new ${event.newCells ?? 0} | findings ${event.findings ?? 0} | ${rate.toFixed(2)} eps/s | eta ${formatDuration(
      etaSeconds
    )}`;

    if (process.stderr.isTTY) {
      const padded = line.padEnd(lastLineLength, " ");
      process.stderr.write(`\r${padded}`);
      lastLineLength = line.length;
      if (event.type === "complete") {
        process.stderr.write("\n");
      }
      return;
    }

    if (event.type === "complete" || done === 1 || done % 10 === 0) {
      process.stderr.write(`${line}\n`);
    }
  };
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
}
