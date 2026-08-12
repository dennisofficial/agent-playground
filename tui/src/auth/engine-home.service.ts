import { Injectable, Optional } from "@nestjs/common";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ATLAS_PATHS, claudeCredentialsFile } from "../domain/paths.js";
import type { ClaudeCredentialBlob } from "./oauth/claude-oauth.client.js";

@Injectable()
export class EngineHomeService {
  /** Held only across write-then-spawn, never for the life of a turn. */
  private gate: Promise<void> = Promise.resolve();
  /**
   * Whose credential is in the file right now. One home per ENGINE — every account of that engine
   * writes the same file — so the read-back needs to know who wrote it last or it would file one
   * account's rotated credential under another's row.
   */
  private lastWritten?: string;

  /**
   * `@Optional()` and defaulted for the same reason `SecretCipherService` takes its key file that
   * way: Nest constructs this with no arguments, a test points it at a temp directory, and without
   * `@Optional()` `emitDecoratorMetadata` records the parameter as `String` and the container fails
   * trying to inject one.
   */
  constructor(@Optional() private readonly claudeHome: string = ATLAS_PATHS.claudeHome) {}

  async claim<T>(
    args: { accountId: string; blob: ClaudeCredentialBlob },
    start: (env: Record<string, string>) => T,
  ): Promise<T> {
    const previous = this.gate;
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return start(this.prepareClaudeHome(args));
    } finally {
      release();
    }
  }

  /** Returns the env overrides the SDK call needs. */
  prepareClaudeHome(args: {
    accountId: string;
    blob: ClaudeCredentialBlob;
  }): Record<string, string> {
    mkdirSync(this.claudeHome, { recursive: true });
    writeFileSync(this.credentialsFile(), JSON.stringify(args.blob), {
      mode: 0o600,
    });
    this.lastWritten = args.accountId;
    return {
      // Session and transcript storage — shared, and deliberately so.
      CLAUDE_CONFIG_DIR: this.claudeHome,
      // Auth — per turn, which is the half that must NOT be shared.
      CLAUDE_CODE_OAUTH_TOKEN: args.blob.claudeAiOauth.accessToken,
    };
  }

  /**
   * What the engine left in the credentials file, if this account is the one whose turn put it there.
   *
   * The engine refreshes that file in place when the access token nears expiry, and the server
   * rotates the refresh token as it does — which silently invalidated the pair Atlas held in the
   * database, because nothing ever read the file back. Whether the observed pair is actually NEW is
   * not decided here: this method answers only "is it attributable to this account", and the vault
   * compares it against what it stored.
   *
   * The attribution is in-process. A second Atlas instance sharing `~/.atlas/claude-home` can write
   * the file between our write and this read, which is why the vault ALSO refuses a pair it can
   * recognise as another account's — see `domain/credential-rotation.ts`.
   */
  observeClaudeCredential(accountId: string): ClaudeCredentialBlob | null {
    if (this.lastWritten !== accountId) return null;
    return this.readClaudeCredential();
  }

  /**
   * The credentials file with no attribution at all — whoever wrote it, whenever.
   *
   * Only for the case where attribution comes from somewhere else: at startup nobody in THIS process
   * has written the file, and a single-account engine has nobody to confuse it with. Every other
   * caller wants `observeClaudeCredential`.
   */
  readClaudeCredential(): ClaudeCredentialBlob | null {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.credentialsFile(), "utf8"),
      );
      return isCredentialBlob(parsed) ? parsed : null;
    } catch {
      // Missing, truncated or not JSON. A turn on its way out must not fail over a file it only
      // wanted to look at.
      return null;
    }
  }

  /** Codex reads `CODEX_HOME` for auth.json AND sessions — one shared home, same reasoning. */
  prepareCodexHome(): Record<string, string> {
    mkdirSync(ATLAS_PATHS.codexHome, { recursive: true });
    return { CODEX_HOME: ATLAS_PATHS.codexHome };
  }

  private credentialsFile(): string {
    return claudeCredentialsFile(this.claudeHome);
  }
}

function isCredentialBlob(value: unknown): value is ClaudeCredentialBlob {
  if (typeof value !== "object" || value === null) return false;
  const oauth = (value as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return false;
  const { accessToken, refreshToken } = oauth as Record<string, unknown>;
  return typeof accessToken === "string" && typeof refreshToken === "string";
}
