import { Injectable } from '@nestjs/common';
import { CodexAuthInvalidError } from './codex-auth-invalid.error';

type CodexIdClaims = {
  email?: unknown;
  'https://api.openai.com/profile'?: { email?: unknown };
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown };
};

/** Parses and validates the Codex `~/.codex/auth.json` blob and the JWTs inside it. */
@Injectable()
export class CodexAuthService {
  decodeAccountEmail(authJson: string): string | undefined {
    try {
      const idToken = (JSON.parse(authJson)?.tokens ?? {}).id_token;
      const claims = this.decodeClaims(idToken);
      const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
      if (typeof email !== 'string') return undefined;
      return email.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  decodeJwtExpMs(jwt: string | undefined): number | null {
    const exp = (this.decodeClaims(jwt) as unknown as { exp?: unknown } | undefined)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  }

  decodeIdentity(idToken: string): { email?: string; accountId?: string; planType?: string } {
    const claims = this.decodeClaims(idToken);
    const auth = claims?.['https://api.openai.com/auth'];
    const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
    return {
      email: typeof email === 'string' ? email.trim() || undefined : undefined,
      accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
      planType: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
    };
  }

  assertValidAuthJson(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new CodexAuthInvalidError('not a JSON object');
    }
    const obj = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown };
    const hasApiKey = typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY.length > 0;
    const tokens = obj.tokens;

    if (hasApiKey && (tokens === undefined || tokens === null)) return;

    if (typeof tokens !== 'object' || tokens === null) {
      throw new CodexAuthInvalidError('missing the "tokens" object (and no OPENAI_API_KEY)');
    }
    const t = tokens as Record<string, unknown>;
    const missing = (['id_token', 'access_token', 'refresh_token'] as const).filter(
      (k) => typeof t[k] !== 'string' || t[k].length === 0,
    );
    if (missing.length > 0) {
      throw new CodexAuthInvalidError(`tokens is missing required field(s): ${missing.join(', ')}`);
    }
  }

  private decodeClaims(idToken: string | undefined): CodexIdClaims | undefined {
    if (typeof idToken !== 'string') return undefined;
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CodexIdClaims;
    } catch {
      return undefined;
    }
  }
}
