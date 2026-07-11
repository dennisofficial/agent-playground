import { EnvService } from '@core/config/env/env.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadSecretsKey } from '../onboarding/secret-cipher';
import type { McpOAuthBlob, McpServerEntity } from '../persistence/entities';
import { McpServerStore } from './mcp-server.store';

/** The callback path (under the guarded `/web` namespace but marked `@Public()`) the provider redirects to. */
export const OAUTH_CALLBACK_PATH = '/web/mcp/oauth/callback';

/** How long before a token's stated expiry we proactively refresh (clock skew + a little headroom). */
const EXPIRY_SKEW_MS = 60_000;

/** Conservative fallback access-token lifetime for providers that issue expiring tokens WITHOUT an
 *  `expires_in`. Used only when a refresh_token exists, so such tokens still get proactively refreshed
 *  instead of silently 401ing at runtime; providers that send `expires_in` are unaffected. */
const DEFAULT_TOKEN_TTL_MS = 55 * 60_000;

/** The verbatim marker written to `validation_error` when a token can no longer be refreshed. */
export const NEEDS_REAUTH = 'needs re-auth';

/** The decoded, verified `state` payload — identifies the target row + gates replay via `nonce`. */
interface StatePayload {
  orgId: string;
  scope: string; // db scope ('*' or a repo id)
  name: string;
  nonce: string;
}

/** The subset of the ESM-only SDK's `client/auth.js` this service calls at runtime (loaded via dynamic import). */
interface AuthSdk {
  auth(
    provider: OAuthClientProvider,
    options: { serverUrl: string | URL; authorizationCode?: string },
  ): Promise<'AUTHORIZED' | 'REDIRECT'>;
}

/**
 * The ONE place Atlas speaks OAuth for MCP servers. Host-authoritative: all token storage + refresh live here
 * (in the encrypted `mcp_servers.oauth_enc` blob), so the in-sandbox hub only ever receives a resolved
 * `Authorization: Bearer …` header (exactly like a static header) and never needs an OAuth code path.
 *
 * It drives the MCP SDK's `auth()` orchestrator (`@modelcontextprotocol/sdk/client/auth.js`) through a per-row
 * {@link RowOAuthProvider} — a DB-backed `OAuthClientProvider`. `auth()`
 * handles discovery → Dynamic Client Registration (which declares OUR redirect_uri, so no mismatch) →
 * authorize/exchange → and, when a refresh token is present, refresh — persisting each step through the provider.
 *
 * The SDK is ESM-only and the host compiles to CommonJS, so it is loaded via a preserved dynamic `import()`
 * (see `EngineEsmModule` for the same pattern); type-only imports above are erased at compile time.
 */
@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);
  private authSdkPromise: Promise<AuthSdk> | undefined;

  constructor(
    private readonly store: McpServerStore,
    private readonly env: EnvService,
  ) {}

  private authSdk(): Promise<AuthSdk> {
    // Cache the dynamic import so the ESM module loads at most once per process.
    this.authSdkPromise ??= import('@modelcontextprotocol/sdk/client/auth.js') as unknown as Promise<AuthSdk>;
    return this.authSdkPromise;
  }

  // ── public API ────────────────────────────────────────────────────────────────────────────────

  /**
   * Kick off interactive consent for an `auth_kind='oauth'` server: discovery + DCR + PKCE authorize, returning
   * the provider's authorize URL for the console to open. Clears any prior tokens (so a "Reconnect" forces a fresh
   * consent) and stamps a fresh `nonce` into the signed `state` that rides to the provider and back to the callback.
   */
  async beginAuthorization(orgId: string, dbScope: string, name: string): Promise<{ authorizeUrl: string }> {
    const row = await this.store.rawRow(orgId, dbScope, name);
    if (!row) throw new BadRequestException('unknown mcp server');
    if (row.auth_kind !== 'oauth') throw new BadRequestException('server is not an oauth server');
    const serverUrl = row.config.url;
    if (!serverUrl) throw new BadRequestException('oauth server has no url');
    this.assertCallbackBase(); // fail loudly if BACKEND_HOST can't build a valid redirect_uri

    // Fresh consent: keep the DCR client registration + discovery, drop stale tokens/verifier, new nonce.
    const blob: McpOAuthBlob = {
      clientInformation: row.oauth_enc ? this.store.readOAuthBlob(row).clientInformation : undefined,
      discoveryState: row.oauth_enc ? this.store.readOAuthBlob(row).discoveryState : undefined,
      nonce: randomBytes(16).toString('hex'),
    };
    await this.store.writeOAuthBlob(orgId, dbScope, name, blob, { validationError: null });

    const provider = new RowOAuthProvider(this, orgId, dbScope, name, blob, row);
    const { auth } = await this.authSdk();
    const result = await auth(provider, { serverUrl });
    if (result !== 'REDIRECT' || !provider.authorizeUrl) {
      throw new BadRequestException(`unexpected oauth begin result: ${result}`);
    }
    this.logger.log(`oauth begin org=${orgId} scope=${dbScope} name=${name}`);
    return { authorizeUrl: provider.authorizeUrl };
  }

  /**
   * Complete consent from the callback: verify the signed `state`, match the stored `nonce` (replay guard),
   * exchange the code for tokens (persisted by the provider), then list the server's tools to record the initial
   * validation. Returns the resolved identity so the callback can tell the console which server connected.
   */
  async completeAuthorization(
    state: string,
    code: string,
  ): Promise<{ orgId: string; scope: string; name: string }> {
    const payload = this.verifyState(state);
    if (!payload) throw new BadRequestException('invalid oauth state');
    const { orgId, scope: dbScope, name, nonce } = payload;

    const row = await this.store.rawRow(orgId, dbScope, name);
    if (!row || row.auth_kind !== 'oauth') throw new BadRequestException('unknown oauth server');
    const blob = this.store.readOAuthBlob(row);
    if (!blob.nonce || blob.nonce !== nonce) throw new BadRequestException('stale or replayed oauth state');
    const serverUrl = row.config.url;
    if (!serverUrl) throw new BadRequestException('oauth server has no url');

    const provider = new RowOAuthProvider(this, orgId, dbScope, name, blob, row);
    const { auth } = await this.authSdk();
    const result = await auth(provider, { serverUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED') throw new BadRequestException(`unexpected oauth complete result: ${result}`);

    // Clear the one-shot consent state (verifier + nonce), keep tokens + client info + discovery.
    provider.blob.codeVerifier = undefined;
    provider.blob.nonce = undefined;
    await this.persist(orgId, dbScope, name, provider.blob, null);

    await this.recordInitialValidation(orgId, dbScope, name, row, provider.blob);
    this.logger.log(`oauth complete org=${orgId} scope=${dbScope} name=${name}`);
    return { orgId, scope: McpServerStore.fromDbScope(dbScope), name };
  }

  /**
   * The current access token for an oauth row, refreshing (and persisting the rotated tokens) when it is within
   * {@link EXPIRY_SKEW_MS} of expiry. Returns `null` — after marking the row `needs re-auth` — when there is no
   * refresh token or the refresh fails. Used by `McpResolver.materialize` to inline the Bearer header.
   */
  async currentAccessToken(row: McpServerEntity): Promise<string | null> {
    return (await this.ensureFresh(row)).token;
  }

  /**
   * Refresh every oauth server for an org+repo, reporting whether any token ROTATED — the driver uses this before
   * a build turn to decide whether to re-write the hub config (`kickMcpHubRefresh`) so a long-lived sandbox picks
   * up a fresh Bearer. Cheap no-op (`rotated:false`) when the org+repo has no oauth servers.
   */
  async refreshForSandbox(orgId: string, repoId: string): Promise<{ rotated: boolean }> {
    const rows = (await this.store.rowsForTurn(orgId, repoId)).filter(
      (r) => r.enabled && r.auth_kind === 'oauth',
    );
    let rotated = false;
    for (const row of rows) {
      const res = await this.ensureFresh(row);
      if (res.rotated) rotated = true;
    }
    return { rotated };
  }

  /** SDK-based validation for an oauth row: connect with the current token and list tools. Never throws. */
  async validate(row: McpServerEntity): Promise<{ discoveredTools?: string[]; error?: string }> {
    const token = await this.currentAccessToken(row);
    if (!token) return { error: NEEDS_REAUTH };
    const url = row.config.url;
    if (!url) return { error: 'oauth server has no url' };
    return this.listToolsWithToken(url, row.transport, token);
  }

  // ── refresh core ────────────────────────────────────────────────────────────────────────────

  private async ensureFresh(row: McpServerEntity): Promise<{ token: string | null; rotated: boolean }> {
    const orgId = row.org_id;
    const dbScope = row.scope;
    const name = row.name;
    const blob = this.store.readOAuthBlob(row);
    const access = blob.tokens?.['access_token'] as string | undefined;
    if (!access) return { token: null, rotated: false };

    if (!this.isNearExpiry(blob)) return { token: access, rotated: false };
    if (!blob.tokens?.['refresh_token']) {
      await this.markNeedsReauth(orgId, dbScope, name, blob);
      return { token: null, rotated: false };
    }
    const serverUrl = row.config.url;
    if (!serverUrl) return { token: access, rotated: false };

    try {
      const provider = new RowOAuthProvider(this, orgId, dbScope, name, blob, row);
      const { auth } = await this.authSdk();
      const result = await auth(provider, { serverUrl }); // refreshes via the stored refresh_token
      const newAccess = provider.blob.tokens?.['access_token'] as string | undefined;
      if (result === 'AUTHORIZED' && newAccess) {
        // Clear any prior needs-reauth marker on a successful refresh.
        if (row.validation_error) await this.store.writeOAuthBlob(orgId, dbScope, name, provider.blob, { validationError: null });
        return { token: newAccess, rotated: newAccess !== access };
      }
      await this.markNeedsReauth(orgId, dbScope, name, provider.blob);
      return { token: null, rotated: false };
    } catch (err) {
      this.logger.warn(`oauth refresh failed org=${orgId} scope=${dbScope} name=${name}: ${String(err)}`);
      await this.markNeedsReauth(orgId, dbScope, name, blob);
      return { token: null, rotated: false };
    }
  }

  private isNearExpiry(blob: McpOAuthBlob): boolean {
    if (!blob.obtainedAt) return false;
    const expiresIn = blob.tokens?.['expires_in'] as number | undefined;
    if (expiresIn) return Date.now() >= blob.obtainedAt + expiresIn * 1000 - EXPIRY_SKEW_MS;
    // No stated expiry: only worth pre-emptively refreshing when we actually CAN (a refresh_token exists).
    // Some providers issue expiring access tokens without an `expires_in`; assume a conservative lifetime so
    // they still get refreshed instead of silently 401ing at runtime. With no refresh_token there is nothing
    // to refresh, so treat the token as long-lived.
    if (!blob.tokens?.['refresh_token']) return false;
    return Date.now() >= blob.obtainedAt + DEFAULT_TOKEN_TTL_MS - EXPIRY_SKEW_MS;
  }

  private async markNeedsReauth(orgId: string, dbScope: string, name: string, blob: McpOAuthBlob): Promise<void> {
    await this.store.writeOAuthBlob(orgId, dbScope, name, blob, { validationError: NEEDS_REAUTH });
  }

  // ── provider persistence hook (called by RowOAuthProvider) ────────────────────────────────────

  /** Persist a provider's in-memory blob back onto its row; optionally set/clear `validation_error`. */
  async persist(
    orgId: string,
    dbScope: string,
    name: string,
    blob: McpOAuthBlob,
    validationError?: string | null,
  ): Promise<void> {
    const opts = validationError === undefined ? undefined : { validationError };
    await this.store.writeOAuthBlob(orgId, dbScope, name, blob, opts);
  }

  // ── redirect_uri + state signing ──────────────────────────────────────────────────────────────

  /** The DCR/exchange redirect_uri, e.g. `https://api.atlas.dltechnologies.co/web/mcp/oauth/callback`. */
  callbackUrl(): string {
    return new URL(OAUTH_CALLBACK_PATH, this.backendBase()).toString();
  }

  private backendBase(): string {
    return this.env.get('BACKEND_HOST');
  }

  /** Fail loudly (rather than register a dead redirect) if BACKEND_HOST is not an absolute http(s) origin. */
  private assertCallbackBase(): void {
    let u: URL;
    try {
      u = new URL(this.backendBase());
    } catch {
      throw new BadRequestException(
        'BACKEND_HOST is not an absolute URL — set it to this backend’s public origin (e.g. http://localhost:4002 in dev, https://api.atlas.dltechnologies.co in prod) before connecting an OAuth MCP server.',
      );
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException(`BACKEND_HOST must be http(s), got ${u.protocol}`);
    }
  }

  private stateKey(): Buffer {
    // Domain-separate from the raw AES key so the HMAC and the cipher never share key material directly.
    return createHmac('sha256', loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY')))
      .update('mcp-oauth-state-v1')
      .digest();
  }

  /** `base64url(json).base64url(hmac)` — a stateless, tamper-evident, instance-independent `state`. */
  signState(payload: StatePayload): string {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const mac = createHmac('sha256', this.stateKey()).update(json).digest();
    return `${json.toString('base64url')}.${mac.toString('base64url')}`;
  }

  private verifyState(state: string): StatePayload | null {
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    let json: Buffer;
    let mac: Buffer;
    try {
      json = Buffer.from(parts[0], 'base64url');
      mac = Buffer.from(parts[1], 'base64url');
    } catch {
      return null;
    }
    const expected = createHmac('sha256', this.stateKey()).update(json).digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
    try {
      const p = JSON.parse(json.toString('utf8')) as StatePayload;
      if (!p.orgId || !p.name || !p.nonce || typeof p.scope !== 'string') return null;
      return p;
    } catch {
      return null;
    }
  }

  // ── initial validation + tool listing (SDK client) ───────────────────────────────────────────

  private async recordInitialValidation(
    orgId: string,
    dbScope: string,
    name: string,
    row: McpServerEntity,
    blob: McpOAuthBlob,
  ): Promise<void> {
    const url = row.config.url;
    const token = blob.tokens?.['access_token'] as string | undefined;
    if (!url || !token) return;
    const result = await this.listToolsWithToken(url, row.transport, token);
    await this.store.recordValidation(orgId, dbScope, name, result);
  }

  /** Connect via the MCP SDK client (http or sse) with a Bearer token and list tools. Never throws. */
  private async listToolsWithToken(
    url: string,
    transport: 'http' | 'sse' | 'stdio',
    token: string,
  ): Promise<{ discoveredTools?: string[]; error?: string }> {
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const requestInit = { headers: { Authorization: `Bearer ${token}` } };
      const client = new Client({ name: 'atlas-mcp-oauth-validator', version: '1.0.0' }, { capabilities: {} });
      const makeTransport = async () => {
        if (transport === 'sse') {
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
          return new SSEClientTransport(new URL(url), { requestInit });
        }
        const { StreamableHTTPClientTransport } = await import(
          '@modelcontextprotocol/sdk/client/streamableHttp.js'
        );
        return new StreamableHTTPClientTransport(new URL(url), { requestInit });
      };
      await client.connect(await makeTransport());
      const tools = await client.listTools();
      await client.close();
      return { discoveredTools: (tools.tools ?? []).map((t) => t.name).filter(Boolean) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * The per-row `OAuthClientProvider` the SDK `auth()` drives — a DB-backed provider.
 * Holds the row's blob in memory and persists back through {@link McpOAuthService.persist}
 * on every save, so client registration, PKCE verifier, tokens, and discovery all survive across the two HTTP
 * requests (begin → callback) and across instances (prod blue/green).
 */
class RowOAuthProvider implements OAuthClientProvider {
  /** Captured by {@link redirectToAuthorization} during `beginAuthorization`. */
  authorizeUrl?: string;

  constructor(
    private readonly svc: McpOAuthService,
    private readonly orgId: string,
    private readonly dbScope: string,
    private readonly name: string,
    readonly blob: McpOAuthBlob,
    private readonly row: McpServerEntity,
  ) {}

  private save(): Promise<void> {
    return this.svc.persist(this.orgId, this.dbScope, this.name, this.blob);
  }

  get redirectUrl(): string {
    return this.svc.callbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    const oauth = this.row.config.oauth ?? {};
    return {
      client_name: `Atlas — ${this.name}`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: oauth.tokenAuthMethod ?? 'none',
      scope: this.withOfflineAccess(oauth.scope),
    };
  }

  /**
   * Add the OIDC `offline_access` scope — which many providers require in order to issue a refresh_token —
   * to the configured scope, but ONLY when the discovered authorization-server or protected-resource
   * metadata advertises it in `scopes_supported`. Gating on advertisement means we never send a scope the
   * provider would reject (some use a different offline mechanism entirely), so this can't break consent.
   * Without a refresh_token an OAuth connection "works once, then 401s with nothing to refresh" — this is
   * the durability fix. NOTE: the SDK's SEP-835 scope resolution prefers protected-resource
   * `scopes_supported` over this clientMetadata scope, so this is only the effective request when the
   * resource advertises no scopes of its own (otherwise it's a harmless no-op / de-duped).
   */
  private withOfflineAccess(configured: string | undefined): string | undefined {
    const disc = this.discoveryState();
    const advertised = [
      ...(disc?.authorizationServerMetadata?.scopes_supported ?? []),
      ...(disc?.resourceMetadata?.scopes_supported ?? []),
    ];
    if (!advertised.includes('offline_access')) return configured;
    const scopes = new Set((configured ?? '').split(/\s+/).filter(Boolean));
    scopes.add('offline_access');
    return [...scopes].join(' ');
  }

  state(): string {
    // The signed, replay-guarded state that rides to the provider and returns on the callback.
    return this.svc.signState({
      orgId: this.orgId,
      scope: this.dbScope,
      name: this.name,
      nonce: this.blob.nonce ?? '',
    });
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.blob.clientInformation as OAuthClientInformation | undefined;
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.blob.clientInformation = info as unknown as Record<string, unknown>;
    await this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.blob.tokens as OAuthTokens | undefined;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.blob.tokens = tokens as unknown as Record<string, unknown>;
    this.blob.obtainedAt = Date.now();
    await this.save();
  }

  redirectToAuthorization(url: URL): void {
    this.authorizeUrl = url.toString();
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.blob.codeVerifier = verifier;
    await this.save();
  }
  codeVerifier(): string {
    if (!this.blob.codeVerifier) throw new Error('no PKCE code verifier saved for this oauth server');
    return this.blob.codeVerifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.blob.discoveryState as OAuthDiscoveryState | undefined;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.blob.discoveryState = state as unknown as Record<string, unknown>;
    await this.save();
  }
}
