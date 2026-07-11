/** Decode the account email from a Codex auth.json blob (display-only, NO signature check). */
export function decodeCodexAccountEmail(authJson: string): string | undefined {
  try {
    const idToken = (JSON.parse(authJson)?.tokens ?? {}).id_token;
    if (typeof idToken !== 'string') return undefined; // API-key-only blob
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = claims?.email ?? claims?.['https://api.openai.com/profile']?.email;
    return typeof email === 'string' && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}
