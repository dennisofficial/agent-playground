/** Claims we care about from the ChatGPT id_token JWT (OpenAI namespaces the auth claims). */
type CodexIdClaims = {
  email?: unknown;
  'https://api.openai.com/profile'?: { email?: unknown };
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown };
};

function decodeClaims(idToken: string | undefined): CodexIdClaims | undefined {
  if (typeof idToken !== 'string') return undefined;
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CodexIdClaims;
  } catch {
    return undefined;
  }
}

/** Extract the account email from a `~/.codex/auth.json` blob (via the id_token JWT). */
export function decodeCodexAccountEmail(authJson: string): string | undefined {
  try {
    const idToken = (JSON.parse(authJson)?.tokens ?? {}).id_token;
    const claims = decodeClaims(idToken);
    const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
    if (typeof email !== 'string') return undefined;
    return email.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Read the `exp` claim (epoch ms) from any JWT — used for Codex access-token expiry. */
export function decodeJwtExpMs(jwt: string | undefined): number | null {
  const exp = (decodeClaims(jwt) as unknown as { exp?: unknown } | undefined)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/** Identity + plan pulled straight from an id_token JWT (used when assembling a fresh auth.json). */
export function decodeCodexIdentity(idToken: string): {
  email?: string;
  accountId?: string;
  planType?: string;
} {
  const claims = decodeClaims(idToken);
  const auth = claims?.['https://api.openai.com/auth'];
  const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
  return {
    email: typeof email === 'string' ? email.trim() || undefined : undefined,
    accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
    planType: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
  };
}
