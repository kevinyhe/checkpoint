import { describe, expect, it } from "vitest";
import { runDiscovery } from "../src/discovery.js";
import { runPlaytest } from "../src/runner.js";

const maybeIt = process.env.SMB_ROM && process.env.SMB_4_2_STATE ? it : it.skip;

describe("optional SMB integration", () => {
  maybeIt("runs a five-second playtest and emits the planned JSON shape", async () => {
    const result = await runPlaytest({
      romPath: process.env.SMB_ROM!,
      statePath: process.env.SMB_4_2_STATE!,
      persona: "glitch-hunter",
      durationSeconds: 5,
      seed: 1
    });

    expect(result.run.game).toBe("super-mario-bros-nes");
    expect(result.run.objective).toBe("world-4-2-known-glitches");
    expect(result.run.durationSeconds).toBe(5);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        persona: "glitch-hunter",
        metrics: expect.objectContaining({
          frames: 300,
          gameSeconds: 5
        }),
        findings: expect.any(Array),
        coverage: expect.any(Array)
      })
    );
  });

  maybeIt("runs a tiny discovery and emits replayable top episodes", async () => {
    const result = await runDiscovery({
      romPath: process.env.SMB_ROM!,
      statePath: process.env.SMB_4_2_STATE!,
      episodes: 3,
      episodeDurationSeconds: 2,
      seed: 1,
      top: 2
    });

    expect(result.discovery).toEqual(
      expect.objectContaining({
        agentType: "rl-go-explore-hybrid",
        strategy: "rl-go-explore",
        episodes: 3,
        top: 2
      })
    );
    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        persona: "coverage-explorer",
        agent: expect.objectContaining({
          type: "rl-go-explore-hybrid",
          episode: expect.any(Number),
          score: expect.any(Number)
        }),
        replayInputs: expect.any(Array)
      })
    );
  });

  maybeIt("runs tiny discovery shards in parallel", async () => {
    const result = await runDiscovery({
      romPath: process.env.SMB_ROM!,
      statePath: process.env.SMB_4_2_STATE!,
      episodes: 4,
      episodeDurationSeconds: 1,
      seed: 2,
      top: 2,
      workers: 2
    });

    expect(result.discovery).toEqual(
      expect.objectContaining({
        agentType: "rl-go-explore-hybrid",
        strategy: "rl-go-explore",
        episodes: 4,
        workers: 2
      })
    );
    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions.every((session) => session.persona === "coverage-explorer")).toBe(true);
  });
});
