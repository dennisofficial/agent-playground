import type { Provider } from "@nestjs/common";

export const CLAUDE_AGENT_SDK = Symbol("CLAUDE_AGENT_SDK");

export type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");

export const claudeSdkProvider: Provider = {
  provide: CLAUDE_AGENT_SDK,
  useFactory: async (): Promise<ClaudeAgentSdk> =>
    import("@anthropic-ai/claude-agent-sdk"),
};
