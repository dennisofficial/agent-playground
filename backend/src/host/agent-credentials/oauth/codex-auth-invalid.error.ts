export class CodexAuthInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Codex subscription credential is invalid: ${reason}. ` +
        `Re-run 'codex login' (ChatGPT plan) and paste the FULL contents of ~/.codex/auth.json — ` +
        `it must include tokens.id_token, tokens.access_token and tokens.refresh_token.`,
    );
    this.name = 'CodexAuthInvalidError';
  }
}
