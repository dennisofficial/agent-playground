import type {
  EngineAuth,
  EngineEvent,
  EngineRunResult,
  ReasoningEffort,
} from '@workspace/agent-engine';
import type { SessionEngine, SessionMode } from '../domain';
import type { AgentMessage } from '../prompt-kit/message';
import type { EngineHomeKey } from './engine-home';

export * from '@workspace/agent-engine';

export interface SandboxGitIdentity {
  name: string;
  email: string;
}

export interface GitAuth {
  gitUrl: string;
  token?: string;
  apiToken?: string;
  identity?: SandboxGitIdentity;
  mode?: 'pat' | 'app';
}

export interface ExecutionTarget {
  containerId: string;
  user?: string;
  worktreeHost?: string;
  gitAuth?: GitAuth;
  evidenceDir?: string;
}

export interface ToolRequestFrame {
  t: 'tool_request';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResponseFrame {
  t: 'tool_response';
  id: string;
  result: unknown;
}

export interface ToolErrorFrame {
  t: 'tool_error';
  id: string;
  message: string;
}

export interface ToolProgressFrame {
  t: 'tool_progress';
  id: string;
  ts: number;
}

export type HostFrame = ToolResponseFrame | ToolErrorFrame | ToolProgressFrame;

export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown>;

export const INTERNAL_PROFILE_AWARENESS_TOOL = '__profile_awareness';

export interface ToolBridgeOptions {
  jobId: string;
  tools: Record<string, ToolImpl>;
  onToolError?: (line: string) => void;
}

export const SANDBOX_RESET_NOTICE = [
  '[sandbox reset] Your sandbox was restarted since your last turn. Any background processes you started',
  'earlier (dev servers, test watchers, headless browsers, docker compose services) are NO LONGER RUNNING',
  'and in-memory state is gone — but files you committed to the worktree are intact, and the cold-boot setup',
  'script already re-ARMED the box (deps/build/index). Run `atlas-svc ps` to see which supervised services',
  'are now `stopped`, and restart ONLY the ones THIS turn actually needs (a planning/review turn may need',
  'none) with `atlas-svc run`. Before relying on any server, verify it is actually up (curl/health-check).',
  'Do not assume anything you started in a previous turn is still alive.',
].join(' ');

export { BG_TASK_CAP_NOTICE } from '../prompt-kit/jit/bg-task-cap';

export interface ResolvedMcpServer {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ResolvedSkill {
  name: string;
  description: string;
  dirPath: string;
  managed?: boolean;
  managedGit?: boolean;
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
}

export interface RunEngineArgs {
  engine: SessionEngine;
  task: AgentMessage;
  cwd: string;
  writableRoots?: string[];
  systemPrompt: AgentMessage;
  sandboxKey: EngineHomeKey;
  sessionId?: string;
  mode: SessionMode;
  auth?: EngineAuth;
  persistAuthRefresh?: boolean;
  userMcpServers?: ResolvedMcpServer[];
  repoConventions?: { name: string; body: string } | null;
  previewInstructions?: string | null;
  skills?: ResolvedSkill[];
  grantedSkills?: string[];
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  onEvent?: (e: EngineEvent) => void;
  richStream?: boolean;
  signal?: AbortSignal;
  steerable?: boolean;
  steerInput?: AsyncIterable<{ id?: string; text: string }>;
  rotationNudge?: {
    softTokens: number;
    reminderDeltaTokens: number;
    softText: AgentMessage;
    reminderText: AgentMessage;
  };
  onTurnRegistered?(turnId: string): void;
  target?: ExecutionTarget;
  toolBridge?: ToolBridgeOptions;
  bridgeCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  turnMeta?: TurnMeta;
  liveRoute?: { channel: string; jobId: string; lane?: string };
}

type HostOnlyArgKey =
  | 'onEvent'
  | 'signal'
  | 'steerInput'
  | 'onTurnRegistered'
  | 'target'
  | 'toolBridge'
  | 'bridgeCall'
  | 'turnMeta'
  | 'liveRoute';
type TransformedArgKey = 'cwd' | 'writableRoots' | 'auth' | 'persistAuthRefresh';
export type SpecVerbatimKey = Exclude<keyof RunEngineArgs, HostOnlyArgKey | TransformedArgKey>;

export const SPEC_VERBATIM_KEYS = [
  'engine',
  'task',
  'systemPrompt',
  'sandboxKey',
  'sessionId',
  'mode',
  'userMcpServers',
  'repoConventions',
  'previewInstructions',
  'skills',
  'grantedSkills',
  'model',
  'modelReasoningEffort',
  'richStream',
  'steerable',
  'rotationNudge',
] as const satisfies readonly SpecVerbatimKey[];

const _SPEC_VERBATIM_KEYS_EXHAUSTIVE: [
  Exclude<SpecVerbatimKey, (typeof SPEC_VERBATIM_KEYS)[number]>,
] extends [never]
  ? true
  : {
      ADD_TO_SPEC_VERBATIM_KEYS: Exclude<SpecVerbatimKey, (typeof SPEC_VERBATIM_KEYS)[number]>;
    } = true;
void _SPEC_VERBATIM_KEYS_EXHAUSTIVE;

export interface TurnSpec extends Pick<RunEngineArgs, SpecVerbatimKey> {
  turnId: string;
  cwd: string;
  writableRoots: string[];
  auth?: { secret: string; kind?: 'setup-token' | 'personal' };
  persistAuthRefresh?: boolean;
  toolBridgeTools?: string[];
}

export function pickKeys<T, K extends readonly (keyof T)[]>(obj: T, keys: K): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

export interface TurnMeta {
  jobId: string;
  orgId: string;
  channel: string;
  lane: string;
  kind: 'brain' | 'step' | 'review' | 'gate' | 'autofix' | 'compaction' | 'rotation';
  ctx?: Record<string, unknown>;
}

export interface EngineRunnerPort {
  readonly pushesLiveRouteEvents?: boolean;
  run(args: RunEngineArgs): Promise<EngineRunResult>;
  reattach?(
    turnId: string,
    containerId: string,
    args: {
      onEvent?: (e: EngineEvent) => void;
      toolBridge?: ToolBridgeOptions;
      signal?: AbortSignal;
      credentialId?: string;
      liveRoute?: { channel: string; jobId: string; lane?: string };
    },
  ): Promise<EngineRunResult>;
  isAttached?(turnId: string): boolean;
  steer?(turnId: string, id: string, text: string): Promise<void>;
  stop?(turnId: string): Promise<void>;
  tryClaimAttach?(turnId: string): boolean;
  releaseAttach?(turnId: string): void;
  consumeClaim?(turnId: string): boolean | undefined;
}

export const ENGINE_RUNNER = Symbol('ENGINE_RUNNER');
