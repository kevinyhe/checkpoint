import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("checkpoint-smb CLI", () => {
  it("rejects missing ROM and state inputs with a clear error", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "run",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
  });

  it("rejects missing viewer inputs with a clear error", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "view",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--run",
        "missing.playtest.json"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
  });

  it("rejects missing wall-clip setup inputs with a clear error", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "wallclip-setup",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--out",
        "missing.wallclip.json"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
  });

  it("rejects missing discovery inputs with a clear error", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
  });

  it("accepts bug discovery focus flags before rejecting missing files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--focus",
        "bugs",
        "--bug-target",
        "all"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
    expect(result.stderr).not.toContain("Invalid focus");
    expect(result.stderr).not.toContain("Invalid bug target");
  });

  it("accepts coverage discovery focus before rejecting missing files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--focus",
        "coverage"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
    expect(result.stderr).not.toContain("Invalid focus");
  });

  it("accepts full-run evolution discovery strategy before rejecting missing files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--strategy",
        "full-run-evolution"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
    expect(result.stderr).not.toContain("Invalid strategy");
  });

  it("accepts RL Go-Explore discovery strategy before rejecting missing files", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--strategy",
        "rl-go-explore"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
    expect(result.stderr).not.toContain("Invalid strategy");
  });

  it("rejects invalid discovery strategy values", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--strategy",
        "checkpoint-only"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid strategy");
    expect(result.stderr).toContain("full-run-evolution");
  });

  it("rejects invalid discovery focus values", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--focus",
        "everywhere"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid focus");
    expect(result.stderr).toContain("coverage");
  });

  it("does not pass the progress callback through workerData for parallel discovery", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--workers",
        "2"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROM file does not exist");
    expect(result.stderr).not.toContain("could not be cloned");
  });

  it("requires an output path or episode log when saving all discovery episodes", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "discover",
        "--rom",
        "missing.nes",
        "--state",
        "missing.state.json",
        "--save-all"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use --out or --episode-log with --save-all");
    expect(result.stderr).not.toContain("ROM file does not exist");
  });
});
