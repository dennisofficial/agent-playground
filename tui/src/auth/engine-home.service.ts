import { Injectable } from "@nestjs/common";
import { mkdirSync, writeFileSync } from "node:fs";
import { ATLAS_PATHS, claudeCredentialsFile } from "../domain/paths.js";
import type { ClaudeCredentialBlob } from "./oauth/claude-oauth.client.js";

@Injectable()
export class EngineHomeService {
  /** Held only across write-then-spawn, never for the life of a turn. */
  private gate: Promise<void> = Promise.resolve();

  async claim<T>(
    blob: ClaudeCredentialBlob,
    start: (env: Record<string, string>) => T,
  ): Promise<T> {
    const previous = this.gate;
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return start(this.prepareClaudeHome(blob));
    } finally {
      release();
    }
  }

  /** Returns the env overrides the SDK call needs. */
  prepareClaudeHome(blob: ClaudeCredentialBlob): Record<string, string> {
    mkdirSync(ATLAS_PATHS.claudeHome, { recursive: true });
    writeFileSync(claudeCredentialsFile(), JSON.stringify(blob), {
      mode: 0o600,
    });
    return {
      // Session and transcript storage — shared, and deliberately so.
      CLAUDE_CONFIG_DIR: ATLAS_PATHS.claudeHome,
      // Auth — per turn, which is the half that must NOT be shared.
      CLAUDE_CODE_OAUTH_TOKEN: blob.claudeAiOauth.accessToken,
    };
  }

  /** Codex reads `CODEX_HOME` for auth.json AND sessions — one shared home, same reasoning. */
  prepareCodexHome(): Record<string, string> {
    mkdirSync(ATLAS_PATHS.codexHome, { recursive: true });
    return { CODEX_HOME: ATLAS_PATHS.codexHome };
  }
}
