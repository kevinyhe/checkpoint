export const SCRIPTED_PERSONAS = ["glitch-hunter", "baseline", "completionist"] as const;
export const DISCOVERY_PERSONA = "coverage-explorer" as const;
export const PERSONAS = [...SCRIPTED_PERSONAS, DISCOVERY_PERSONA] as const;
export type Persona = (typeof PERSONAS)[number];
export type ScriptedPersona = (typeof SCRIPTED_PERSONAS)[number];
export type PersonaOption = ScriptedPersona | "all";

export const FINDING_TYPES = [
  "wrong-warp-candidate",
  "wall-clip-risk",
  "hidden-vine",
  "soft-stall",
  "death-loop",
  "route-blocked",
  "emulator-error",
  "impossible-transition",
  "transition-loop"
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export type Severity = "info" | "low" | "medium" | "high";
export type SessionStatus = "passed" | "failed" | "inconclusive";

export const BUTTON_NAMES = [
  "A",
  "B",
  "SELECT",
  "START",
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT"
] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];

export interface ReproInputRange {
  frameStart: number;
  frameEnd: number;
  buttons: ButtonName[];
}

export interface SmbRamSnapshot {
  rawWorld: number;
  rawLevel: number;
  world: number;
  level: number;
  playerState: number;
  playerStateName: string;
  playerFloatState: number;
  currentScreen: number;
  nextScreen: number;
  xOnScreen: number;
  yOnScreen: number;
  levelPage: number;
  progress: number;
  horizontalSpeed: number;
  horizontalSpeedAbs: number;
  verticalVelocity: number;
  lives: number;
  coins: number;
  score: number;
  gameTimer: number;
  gameMode: number;
  levelLoading: number;
  levelEntry: number;
  scrollLock: number;
  scrollAmount: number;
  areaOffset: number;
  areaMusic: number;
  eventMusic: number;
  soundEffect1: number;
  soundEffect2: number;
  soundEffect3: number;
  playerCollisionBits: number;
  enemyCollisionBits: number;
  playerHitDetectFlag: number;
  warpZoneControl: number;
  changeAreaTimer: number;
  deathMusicLoaded: number;
  preLevel: number;
  powerupDrawn: number;
  powerupState: number;
  powerupType: number;
  enemyTypes: number[];
  vineTileCount: number;
  pipeTileCount: number;
  hiddenBlockTileCount: number;
  onVine: boolean;
  enteringPipe: boolean;
  dying: boolean;
  vineVisible: boolean;
  warpZoneVisible: boolean;
  pipeInteraction: boolean;
  roomId: string;
}

export interface FrameSample extends SmbRamSnapshot {
  frame: number;
  frameHash: string;
}

export interface OverlaySample {
  frame: number;
  rawWorld: number;
  rawLevel: number;
  world: number;
  level: number;
  currentScreen: number;
  progress: number;
  x: number;
  y: number;
  dying: boolean;
}

export interface Finding {
  type: FindingType;
  severity: Severity;
  frameStart: number;
  frameEnd: number;
  summary: string;
  evidence: Record<string, unknown>;
  reproInputs: ReproInputRange[];
}

export interface SessionMetrics {
  frames: number;
  gameSeconds: number;
  maxProgress: number;
  deaths: number;
  stalls: number;
  transitions: number;
}

export interface SessionResult {
  persona: Persona;
  status: SessionStatus;
  metrics: SessionMetrics;
  coverage: string[];
  findings: Finding[];
  replayInputs: ReproInputRange[];
  agent?: DiscoveryAgentMetadata;
}

export interface DiscoveryAgentMetadata {
  type: "coverage-guided-explorer" | "go-explore-checkpoint" | "full-run-evolution" | "rl-go-explore-hybrid";
  episode: number;
  episodeId: string;
  parentId?: string;
  startCell?: string;
  startFrame?: number;
  prefixFrames?: number;
  suffixFrames?: number;
  score: number;
  newCells: number;
  cellsVisited: number;
  uniqueCells: number;
  bugScore: number;
  progressScore?: number;
  coverageScore?: number;
  coverageGoalsHit?: string[];
  routeScore?: number;
  speedScore?: number;
  roomScore?: number;
  gameScore?: number;
  gameScoreDelta?: number;
  milestoneFrames?: Record<string, number>;
  roomTransitions?: number;
  roomsReached?: string[];
  progressDelta?: number;
  targetReached?: boolean;
  obstacleFrame?: number;
  obstacleProgress?: number;
  obstacleDurationFrames?: number;
  obstacleReason?: string;
  phase?: "rl-explore" | "go-explore-bug";
  rlEpsilon?: number;
  rlStateCount?: number;
  rlUpdateCount?: number;
  focus?: DiscoveryFocus;
  bugTarget?: BugTarget;
  mutation: string;
}

export type DiscoveryStrategy = "rl-go-explore" | "full-run-evolution" | "go-explore" | "trace-mutation";
export type DiscoveryFocus = "balanced" | "bugs" | "progress" | "coverage";
export type BugTarget = "all" | "warp-zone" | "wall-clip";

export interface CoverageGoalSummary {
  target: "world-4-2-full";
  required: number;
  covered: number;
  percent: number;
  complete: boolean;
  missing: string[];
}

export interface DiscoverySummary {
  agentType: "coverage-guided-explorer" | "go-explore-checkpoint" | "full-run-evolution" | "rl-go-explore-hybrid";
  strategy: DiscoveryStrategy;
  focus: DiscoveryFocus;
  bugTarget: BugTarget;
  episodes: number;
  episodeDurationSeconds: number;
  top: number;
  seed: number;
  workers: number;
  uniqueCells: number;
  totalFindings: number;
  bestScore: number;
  bestSavedScore: number;
  bestProgress: number;
  bestCoveragePercent?: number;
  targetProgress: number;
  targetReached: boolean;
  checkpointCount: number;
  corpusSize: number;
  coverageGoal?: CoverageGoalSummary;
  episodeLog?: EpisodeLogSummary;
}

export interface EpisodeLogSummary {
  format: "jsonl";
  path: string;
  episodes: number;
}

export interface EpisodeLogRecord {
  episode: number;
  session: SessionResult;
  overlaySamples: OverlaySample[];
}

export interface RunMetadata {
  id: string;
  game: "super-mario-bros-nes";
  objective: "world-4-2-known-glitches";
  durationSeconds: number;
  seed: number;
  romSha1: string;
  stateSha1: string;
}

export interface RunResult {
  run: RunMetadata;
  sessions: SessionResult[];
  discovery?: DiscoverySummary;
}

export interface RunOptions {
  romPath: string;
  statePath: string;
  persona: PersonaOption;
  durationSeconds: number;
  seed: number;
  outPath?: string;
}

export interface DiscoverOptions {
  romPath: string;
  statePath: string;
  episodes: number;
  episodeDurationSeconds: number;
  seed: number;
  top: number;
  outPath?: string;
  workers?: number;
  progress?: boolean;
  strategy?: DiscoveryStrategy;
  focus?: DiscoveryFocus;
  bugTarget?: BugTarget;
  checkpointLimit?: number;
  routeSeed?: boolean;
  saveAll?: boolean;
  episodeLogPath?: string;
  onProgress?: (event: DiscoveryProgressEvent) => void;
}

export interface DiscoveryProgressEvent {
  type: "episode" | "complete";
  episode: number;
  episodes: number;
  workerIndex: number;
  workers: number;
  score?: number;
  newCells?: number;
  findings?: number;
  bestScore?: number;
  elapsedMs: number;
}
