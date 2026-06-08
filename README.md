# Checkpoint

Simulating human-like autonomous AI agents to test gameplay and catch bugs that frustrate players. Designed for indie and AAA developers without dedicated QA resources.
```
checkpoint-smb <command> [options]
```

---

## Table of Contents

- [Checkpoint](#checkpoint)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Getting a Save State](#getting-a-save-state)
  - [Commands](#commands)
    - [validate-state](#validate-state)
    - [run](#run)
    - [discover](#discover)
    - [view](#view)
    - [wallclip-setup](#wallclip-setup)
  - [Output Format](#output-format)
  - [Development](#development)

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20.16.0 |
| npm | bundled with Node |
| Super Mario Bros. NES ROM | legally owned copy |

> Checkpoint never ships a ROM. You must provide your own legally-obtained `Super Mario Bros. (World).nes` file.

---

## Installation

```bash
git clone https://github.com/kevinyhe/checkpoint.git
cd checkpoint
npm install
npm run build        # compiles TypeScript → dist/
```

After building, the CLI is available at `node dist/cli.js`. All examples below use that path.

**Verify the build:**

```bash
node dist/cli.js --version
# 0.1.0
```

---

## Getting a Save State

Every Checkpoint command requires a JSNES save state positioned exactly at the start of **World 4-2**. You capture this once from your own ROM using the bundled browser tool.

**Step 1 — start the helper server**

```bash
npm run state-helper
# State capture helper: http://127.0.0.1:4173/tools/state-capture.html
```

> Alternatively, open `tools/state-capture.html` directly in a browser if your browser permits local file access.

**Step 2 — load your ROM**

Open the printed URL, then click **Choose ROM** and select your `Super Mario Bros.nes` file. The emulator starts running.

**Step 3 — navigate to World 4-2**

Play to World 4-2 (or use warp zones). The level should be fully loaded on screen.

**Step 4 — download the state**

Click **Download 4-2 State**. Save the file to a known path, e.g.:

```
states/world-4-2.state.json
```

**Step 5 — validate the state**

```bash
node dist/cli.js validate-state \
  --rom  roms/smb.nes \
  --state states/world-4-2.state.json
```

Expected output:

```json
{
  "ok": true,
  "world": 4,
  "level": 2
}
```

If `"ok"` is `false`, revisit Step 3—the emulator must be paused inside the level, not in a title screen or transition.

---

## Commands

### validate-state

Checks that a ROM + state file pair loads and normalises to World 4-2. Useful after re-capturing a state or switching ROMs.

```bash
node dist/cli.js validate-state \
  --rom   <file.nes> \
  --state <state.json>
```

| Option | Required | Description |
|---|---|---|
| `--rom` | ✓ | Path to your SMB NES ROM |
| `--state` | ✓ | Path to a JSNES save state |

Exits with code `1` if validation fails.

---

### run

Runs one or more scripted AI personas against the emulator for a fixed time budget and reports what each one found.

```bash
node dist/cli.js run \
  --rom   roms/smb.nes \
  --state states/world-4-2.state.json \
  --out   runs/playtest.json
```

**Options**

| Option | Default | Description |
|---|---|---|
| `--rom` | — | *(required)* Path to the SMB ROM |
| `--state` | — | *(required)* Path to the World 4-2 save state |
| `--persona` | `all` | `glitch-hunter`, `baseline`, `completionist`, or `all` |
| `--duration` | `120` | Seconds of emulator time per persona |
| `--seed` | `1` | Integer seed for deterministic runs |
| `--out` | stdout | Write JSON result to this file instead of printing |

**Personas**

| Persona | Behaviour |
|---|---|
| `baseline` | Steady rightward run with a fixed jump cadence — establishes a normal-play baseline |
| `completionist` | Explores level geometry: pipes, vines, detours — maximises coverage |
| `glitch-hunter` | Probes wall-clip and warp-zone trigger windows with deliberate micro-movements |

**Example — run only the glitch-hunter for 60 seconds:**

```bash
node dist/cli.js run \
  --rom   roms/smb.nes \
  --state states/world-4-2.state.json \
  --persona glitch-hunter \
  --duration 60 \
  --out   runs/glitch-hunt.json
```

---

### discover

Runs a coverage-guided explorer that autonomously generates and mutates input sequences to maximise game-state coverage and find bugs. More thorough than `run` but takes longer.

```bash
node dist/cli.js discover \
  --rom      roms/smb.nes \
  --state    states/world-4-2.state.json \
  --episodes 200 \
  --out      runs/discovery.json
```

**Core options**

| Option | Default | Description |
|---|---|---|
| `--rom` | — | *(required)* |
| `--state` | — | *(required)* |
| `--episodes` | `200` | Total exploration episodes to run |
| `--episode-duration` | `45` | Seconds of emulator time per episode |
| `--seed` | `1` | Deterministic seed |
| `--top` | `10` | Number of top-scoring episodes saved to output |
| `--out` | stdout | Write JSON result here |

**Strategy (`--strategy`)**

| Value | Description |
|---|---|
| `rl-go-explore` *(default)* | RL exploration combined with Go-Explore checkpointing |
| `go-explore` | Pure Go-Explore: checkpoints interesting states, revisits them |
| `full-run-evolution` | Evolves complete run traces end-to-end |
| `trace-mutation` | Mutates existing best traces |

**Focus (`--focus`)**

| Value | Description |
|---|---|
| `balanced` *(default)* | Weighs bug-finding and coverage equally |
| `bugs` | Prioritises finding-prone state regions |
| `progress` | Maximises level progress |
| `coverage` | Maximises unique game-states visited |

**Bug target (`--bug-target`)**

| Value | Description |
|---|---|
| `all` *(default)* | Hunt both warp-zone and wall-clip bugs |
| `warp-zone` | Focus on wrong-warp triggers |
| `wall-clip` | Focus on wall-clip geometry |

**Performance options**

| Option | Default | Description |
|---|---|---|
| `--workers` | `1` | Parallel worker shards (set to CPU count for speed) |
| `--checkpoint-limit` | `160` | In-memory Go-Explore checkpoints per worker |
| `--route-seed` / `--no-route-seed` | on | Seed with a RAM-feedback progress controller episode |

**Logging options**

| Option | Description |
|---|---|
| `--save-all` | Write every episode to a `.jsonl` sidecar (for viewer overlay) |
| `--episode-log <file.jsonl>` | Explicit path for the episode sidecar |
| `--no-progress` | Suppress the stderr progress line |

**Example — aggressive 4-worker bug hunt targeting wall-clip:**

```bash
node dist/cli.js discover \
  --rom        roms/smb.nes \
  --state      states/world-4-2.state.json \
  --episodes   500 \
  --workers    4 \
  --strategy   rl-go-explore \
  --focus      bugs \
  --bug-target wall-clip \
  --save-all \
  --out        runs/discovery.json
```

Progress is printed to stderr in real time:

```
[discover] 47/500 episodes (4 workers) | best 0.84 | latest 0.61 | new 3 | findings 2 | 1.23 eps/s | eta 3m45s
```

---

### view

Starts a local HTTP server and opens a browser-based JSNES viewer that replays stored controller inputs from a `run` or `discover` result.

```bash
node dist/cli.js view \
  --rom   roms/smb.nes \
  --state states/world-4-2.state.json \
  --run   runs/playtest.json
```

Then open the printed URL (default `http://localhost:4174`), pick a persona from the dropdown, and watch the replay.

**Options**

| Option | Default | Description |
|---|---|---|
| `--rom` | — | *(required)* Same ROM used for the run |
| `--state` | — | *(required)* Same state used for the run |
| `--run` | — | *(required)* Path to a `run` or `discover` result JSON |
| `--episodes` | — | Optional `.jsonl` sidecar for overlay mode (from `--save-all`) |
| `--port` | `4174` | Local port for the viewer server |

Press **Ctrl+C** to stop the server.

---

### wallclip-setup

Generates a deterministic, replayable run that reproduces the 4-2 wall-clip setup frame-perfectly. Useful for creating a reference repro to attach to a bug report or verify a fix.

```bash
node dist/cli.js wallclip-setup \
  --rom   roms/smb.nes \
  --state states/world-4-2.state.json \
  --out   runs/wallclip-setup.json
```

**Options**

| Option | Default | Description |
|---|---|---|
| `--rom` | — | *(required)* |
| `--state` | — | *(required)* |
| `--out` | — | *(required)* Output path for the setup run JSON |
| `--duration` | `45` | Search budget in seconds |
| `--seed` | `1` | Deterministic seed |
| `--source-run` | — | Extract the best wall-clip episode from an existing discovery run instead of searching from scratch |
| `--episode-log` | — | Optional `.jsonl` sidecar for viewer overlay |

**Example — extract from an existing discovery run:**

```bash
node dist/cli.js wallclip-setup \
  --rom        roms/smb.nes \
  --state      states/world-4-2.state.json \
  --source-run runs/discovery.json \
  --out        runs/wallclip-setup.json
```

View the result the same way as any other run:

```bash
node dist/cli.js view \
  --rom   roms/smb.nes \
  --state states/world-4-2.state.json \
  --run   runs/wallclip-setup.json
```

---

## Output Format

All commands that produce a result write the same JSON structure:

```jsonc
{
  "run": {
    "id": "...",
    "game": "super-mario-bros-nes",
    "objective": "world-4-2-known-glitches",
    "durationSeconds": 120,
    "seed": 1,
    "romSha1": "...",
    "stateSha1": "..."
  },
  "sessions": [
    {
      "persona": "glitch-hunter",
      "status": "failed",          // passed | failed | inconclusive
      "metrics": {
        "frames": 7200,
        "gameSeconds": 120,
        "maxProgress": 0.84,
        "deaths": 1,
        "stalls": 0,
        "transitions": 3
      },
      "coverage": ["4-2-room-0", "4-2-room-1", ...],
      "findings": [
        {
          "type": "wall-clip-risk",
          "severity": "high",        // info | low | medium | high
          "frameStart": 1402,
          "frameEnd": 1458,
          "summary": "...",
          "evidence": { ... },
          "reproInputs": [...]
        }
      ],
      "replayInputs": [...]
    }
  ],
  "discovery": { ... }  // present on discover runs
}
```

**Finding types**

| Type | Meaning |
|---|---|
| `wrong-warp-candidate` | Warp zone entered or nearly triggered off-route |
| `wall-clip-risk` | Player geometry approached a known clip window |
| `hidden-vine` | Hidden vine block activated |
| `soft-stall` | No progress for an extended window |
| `death-loop` | Repeated death in the same region |
| `route-blocked` | Level progress permanently halted |
| `impossible-transition` | Room/world transition that should not be reachable |
| `transition-loop` | Repeated room transitions forming a cycle |

---

## Development

```bash
# Run without building (uses tsx to transpile on the fly)
npm run dev -- run --rom roms/smb.nes --state states/world-4-2.state.json

# Type-check only (no emit)
npm run typecheck

# Run the test suite
npm test

# Rebuild after source changes
npm run build
```

The source lives in `src/`. Key files:

| File | Role |
|---|---|
| `src/cli.ts` | Command definitions (entry point) |
| `src/runner.ts` | `run` command orchestration |
| `src/discovery.ts` | `discover` coverage-guided engine |
| `src/personas.ts` | Scripted persona input logic |
| `src/detectors.ts` | Bug-finding analysis pass |
| `src/emulator.ts` | Headless JSNES wrapper |
| `src/smb-ram.ts` | SMB-specific RAM address decoding |
| `src/viewer-server.ts` | Local HTTP server for the browser viewer |
| `tools/state-capture.html` | Browser tool for capturing save states |
| `tools/run-viewer.html` | Browser viewer for replaying runs |
