export { analyzeSession, computeMetrics, findStallWindows } from "./detectors.js";
export {
  createArchiveCell,
  classifyWorld42CoverageGoals,
  chooseArchiveEntry,
  chooseFullRunEvolutionParent,
  createBaselineProgressControllerConfig,
  createRouteSeedControllerConfig,
  CheckpointActionFuzzer,
  CoverageGoalController,
  WallClipProbeController,
  WallClipTrickController,
  WarpZoneProbeController,
  computeGameScoreStats,
  computeMilestoneFrames,
  computeRoomStats,
  expandMacroTrace,
  generateFreshMacroTrace,
  mutateMacroTrace,
  mutateFullRunTrace,
  mutateProgressControllerConfig,
  runDiscovery,
  scoreArchiveSelection,
  scoreBugHotspot,
  scoreCoverageGoals,
  scoreCoverageParent,
  scoreDiscoveryEpisode,
  scoreDiscoveryProgress,
  scoreGameScoreDelta,
  scoreRooms,
  scoreSpeedMilestones,
  scoreFindings,
  selectSavedDiscoverySessions,
  summarizeWorld42CoverageGoals,
  upsertArchiveCheckpoint,
  type MacroActionName,
  type MacroStep,
  type ProgressControllerConfig
} from "./discovery.js";
export { HeadlessNes } from "./emulator.js";
export { executeEpisode, sessionFromExecution } from "./episode.js";
export { buttonsForFrame, hasReplayInputs } from "./replay.js";
export { runPlaytest, validateState, type ValidateStateResult } from "./runner.js";
export { decodeSmbRam, isWorld42, SMB_RAM } from "./smb-ram.js";
export type {
  ButtonName,
  BugTarget,
  DiscoverOptions,
  DiscoveryFocus,
  DiscoveryStrategy,
  DiscoveryAgentMetadata,
  DiscoverySummary,
  Finding,
  FrameSample,
  Persona,
  PersonaOption,
  RunOptions,
  RunResult,
  SessionResult
} from "./types.js";
