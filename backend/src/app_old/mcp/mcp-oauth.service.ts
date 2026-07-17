import { EnvService } from '@core/config/env/env.service';
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
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadSecretsKey } from '../onboarding/secret-cipher';
import type { McpOAuthBlob, McpServerEntity } from '../persistence/entities';
import { McpServerStore } from './mcp-server.store';

export const OAUTH_CALLBACK_PATH = '/web/mcp/oauth/callback';

const EXPIRY_SKEW_MS = 60_000;

const DEFAULT_TOKEN_TTL_MS = 55 * 60_000;

export const NEEDS_REAUTH = 'needs re-auth';

interface StatePayload {
  orgId: string;
  scope: string; // db scope ('*' or a repo id)
  name: string;
  nonce: string;
}

interface AuthSdk {
  auth(
    provider: OAuthClientProvider,
    options: {
      serverUrl: string | URL;
      authorizationCode?: string;
      resourceMetadataUrl?: URL;
    },
  ): Promise<'AUTHORIZED' | 'REDIRECT'>;
  extractResourceMetadataUrl(res: Response): URL | undefined;
}

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);
  private authSdkPromise: Promise<AuthSdk> | undefined;

  constructor(
    private readonly store: McpServerStore,
    private readonly env: EnvService,
  ) {}

  private authSdk(): Promise<AuthSdk> {
    this.authSdkPromise ??=
      import('@modelcontextprotocol/sdk/client/auth.js') as unknown as Promise<AuthSdk>;
    return this.authSdkPromise;
  }

  async beginAuthorization(
    orgId: string,
    dbScope: string,
    name: string,
  ): Promise<{ authorizeUrl: string }> {
    const row = await this.store.rawRow(orgId, dbScope, name);
    if (!row) throw new BadRequestException('unknown mcp server');
    if (row.auth_kind !== 'oauth') throw new BadRequestException('server is not an oauth server');
    const serverUrl = row.config.url;
    if (!serverUrl) throw new BadRequestException('oauth server has no url');
    this.assertCallbackBase(); // fail loudly if BACKEND_HOST can't build a valid redirect_uri

    const blob: McpOAuthBlob = { nonce: randomBytes(16).toString('hex') };
    await this.store.writeOAuthBlob(orgId, dbScope, name, blob, {
      validationError: null,
    });

    const resourceMetadataUrl = await this.probeResourceMetadataUrl(serverUrl);

    const provider = new RowOAuthProvider(this, orgId, dbScope, name, blob, row);
    const { auth } = await this.authSdk();
    const result = await auth(provider, { serverUrl, resourceMetadataUrl });
    if (result !== 'REDIRECT' || !provider.authorizeUrl) {
      throw new BadRequestException(`unexpected oauth begin result: ${result}`);
    }
    this.logger.log(
      `oauth begin org=${orgId} scope=${dbScope} name=${name}${resourceMetadataUrl ? ` rmu=${resourceMetadataUrl.href}` : ''}`,
    );
    return { authorizeUrl: provider.authorizeUrl };
  }

  private async probeResourceMetadataUrl(serverUrl: string): Promise<URL | undefined> {
    try {
      const { extractResourceMetadataUrl } = await this.authSdk();
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'atlas', version: '1.0' },
          },
        }),
      });
      return extractResourceMetadataUrl(res);
    } catch (err) {
      this.logger.warn(`oauth resource-metadata probe failed for ${serverUrl}: ${String(err)}`);
      return undefined;
    }
  }

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
    if (!blob.nonce || blob.nonce !== nonce)
      throw new BadRequestException('stale or replayed oauth state');
    const serverUrl = row.config.url;
    if (!serverUrl) throw new BadRequestException('oauth server has no url');

    const provider = new RowOAuthProvider(this, orgId, dbScope, name, blob, row);
    const { auth } = await this.authSdk();
    const result = await auth(provider, { serverUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED')
      throw new BadRequestException(`unexpected oauth complete result: ${result}`);

    provider.blob.codeVerifier = undefined;
    provider.blob.nonce = undefined;
    await this.persist(orgId, dbScope, name, provider.blob, null);

    await this.recordInitialValidation(orgId, dbScope, name, row, provider.blob);
    this.logger.log(`oauth complete org=${orgId} scope=${dbScope} name=${name}`);
    return { orgId, scope: McpServerStore.fromDbScope(dbScope), name };
  }

  async currentAccessToken(row: McpServerEntity): Promise<string | null> {
    return (await this.ensureFresh(row)).token;
  }

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

  async validate(row: McpServerEntity): Promise<{ discoveredTools?: string[]; error?: string }> {
    const token = await this.currentAccessToken(row);
    if (!token) return { error: NEEDS_REAUTH };
    const url = row.config.url;
    if (!url) return { error: 'oauth server has no url' };
    return this.listToolsWithToken(url, row.transport, token);
  }

  private async ensureFresh(
    row: McpServerEntity,
  ): Promise<{ token: string | null; rotated: boolean }> {
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
        if (row.validation_error)
          await this.store.writeOAuthBlob(orgId, dbScope, name, provider.blob, {
            validationError: null,
          });
        return { token: newAccess, rotated: newAccess !== access };
      }
      await this.markNeedsReauth(orgId, dbScope, name, provider.blob);
      return { token: null, rotated: false };
    } catch (err) {
      this.logger.warn(
        `oauth refresh failed org=${orgId} scope=${dbScope} name=${name}: ${String(err)}`,
      );
      await this.markNeedsReauth(orgId, dbScope, name, blob);
      return { token: null, rotated: false };
    }
  }

  private isNearExpiry(blob: McpOAuthBlob): boolean {
    if (!blob.obtainedAt) return false;
    const expiresIn = blob.tokens?.['expires_in'] as number | undefined;
    if (expiresIn) return Date.now() >= blob.obtainedAt + expiresIn * 1000 - EXPIRY_SKEW_MS;
    if (!blob.tokens?.['refresh_token']) return false;
    return Date.now() >= blob.obtainedAt + DEFAULT_TOKEN_TTL_MS - EXPIRY_SKEW_MS;
  }

  private async markNeedsReauth(
    orgId: string,
    dbScope: string,
    name: string,
    blob: McpOAuthBlob,
  ): Promise<void> {
    await this.store.writeOAuthBlob(orgId, dbScope, name, blob, {
      validationError: NEEDS_REAUTH,
    });
  }

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

  callbackUrl(): string {
    return new URL(OAUTH_CALLBACK_PATH, this.backendBase()).toString();
  }

  private backendBase(): string {
    return this.env.get('BACKEND_HOST');
  }

  private assertCallbackBase(): void {
    let u: URL;
    try {
      u = new URL(this.backendBase());
    } catch {
      throw new BadRequestException(
        'BACKEND_HOST is not an absolute URL — set it to this backend’s public origin (e.g. http://localhost:4002 in dev, https://api.byatlas.io in prod) before connecting an OAuth MCP server.',
      );
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException(`BACKEND_HOST must be http(s), got ${u.protocol}`);
    }
  }

  private stateKey(): Buffer {
    return createHmac('sha256', loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY')))
      .update('mcp-oauth-state-v1')
      .digest();
  }

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

  private async listToolsWithToken(
    url: string,
    transport: 'http' | 'sse' | 'stdio',
    token: string,
  ): Promise<{ discoveredTools?: string[]; error?: string }> {
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const requestInit = { headers: { Authorization: `Bearer ${token}` } };
      const client = new Client(
        { name: 'atlas-mcp-oauth-validator', version: '1.0.0' },
        { capabilities: {} },
      );
      const makeTransport = async () => {
        if (transport === 'sse') {
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
          return new SSEClientTransport(new URL(url), { requestInit });
        }
        const { StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return new StreamableHTTPClientTransport(new URL(url), { requestInit });
      };
      await client.connect(await makeTransport());
      const tools = await client.listTools();
      await client.close();
      return {
        discoveredTools: (tools.tools ?? []).map((t) => t.name).filter(Boolean),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class RowOAuthProvider implements OAuthClientProvider {
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
    if (!this.blob.codeVerifier)
      throw new Error('no PKCE code verifier saved for this oauth server');
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
