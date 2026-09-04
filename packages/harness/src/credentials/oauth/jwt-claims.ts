export type JwtClaims = Record<string, unknown> & {
  exp?: unknown
  email?: unknown
  'https://api.openai.com/profile'?: { email?: unknown }
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown }
}

/** Claims parsing only — a stored token is never signature-checked because Atlas is its audience. */
export const decodeJwtClaims = (jwt: string): JwtClaims | undefined => {
  const payload = jwt.split('.')[1]
  if (payload === undefined || payload.length === 0) return undefined

  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null) return undefined
    return claims as JwtClaims
  } catch {
    return undefined
  }
}
