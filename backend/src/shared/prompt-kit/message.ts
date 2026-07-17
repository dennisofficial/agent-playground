
declare const AGENT_MESSAGE_BRAND: unique symbol;

export type AgentMessage = string & {
  readonly [AGENT_MESSAGE_BRAND]: 'AgentMessage';
};

export function agentMessage(body: string): AgentMessage {
  return body as AgentMessage;
}

export function fromExternal(body: string): AgentMessage {
  return body as AgentMessage;
}

export const SEALED_DELIVERY_PRIMITIVES = [
  'steerUserMessage(', // raw streaming-input steer (SDKUserMessage constructor)
  'Sdk.query(', // direct Claude/Codex SDK session start (`claudeSdk.query(` / `codexSdk.query(`) — the `Sdk.`
] as const;

export const SANCTIONED_SEAM_GLOBS = [
  'src/shared/prompt-kit/**',
  'src/shared/engine/engine-core.ts',
  'src/shared/engine/engine-core/**',
  'src/app/brain/jit-host-executor.ts',
] as const;

const SANCTIONED_SEAM_ROOTS = ['src/app/', 'src/shared/'] as const;

export function assertEnforcementSeamConfigured(): void {
  if ((SEALED_DELIVERY_PRIMITIVES as readonly unknown[]).length === 0) {
    throw new Error(
      'enforcement seam misconfigured: SEALED_DELIVERY_PRIMITIVES is empty — the structural lint would seal nothing',
    );
  }
  if ((SANCTIONED_SEAM_GLOBS as readonly unknown[]).length === 0) {
    throw new Error(
      'enforcement seam misconfigured: SANCTIONED_SEAM_GLOBS is empty — every sealed call would read as a violation',
    );
  }
  for (const glob of SANCTIONED_SEAM_GLOBS) {
    if (!SANCTIONED_SEAM_ROOTS.some((root) => glob.startsWith(root))) {
      throw new Error(
        `enforcement seam misconfigured: sanctioned glob ${JSON.stringify(glob)} is not under src/app/ or src/shared/ (the lint scans src/app/** + src/shared/**)`,
      );
    }
  }
}
