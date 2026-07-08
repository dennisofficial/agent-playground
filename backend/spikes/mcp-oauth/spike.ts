/**
 * SPIKE — MCP OAuth (Jira/Atlassian reference). Purpose: prove the redirect_uri concern is a non-issue.
 *
 * The worry: "OAuth callbacks yell if the redirect_uri doesn't match." That is only true for PRE-REGISTERED
 * OAuth apps (you configure fixed redirect URIs in a provider dashboard, and any mismatch is rejected). The
 * MCP authorization spec instead uses DYNAMIC CLIENT REGISTRATION (DCR): the client registers itself with the
 * auth server AT RUNTIME and declares its OWN redirect_uri. The provider stores exactly what we send, so the
 * later authorize request's redirect_uri matches by construction — no dashboard, no mismatch. This spike
 * registers `http://localhost:<PORT>/callback` via DCR and completes the whole round-trip against a REAL MCP
 * server, so we can see with our own eyes whether (a) the provider supports DCR and (b) the loopback callback
 * is accepted.
 *
 * It also doubles as a REFERENCE for the real implementation: the `SpikeOAuthProvider` below is exactly the
 * shape of the `OAuthClientProvider` the production `McpOAuthService` + in-sandbox hub will implement (backed
 * by the encrypted `mcp_servers.oauth_enc` blob instead of a local JSON file).
 *
 * Run (from backend/):
 *   pnpm exec tsx spikes/mcp-oauth/spike.ts                       # default: Atlassian remote MCP
 *   MCP_URL=https://mcp.atlassian.com/v1/sse pnpm exec tsx spikes/mcp-oauth/spike.ts
 *   MCP_URL=<any remote MCP server url> pnpm exec tsx spikes/mcp-oauth/spike.ts
 * (If `tsx` isn't installed: `npx --yes tsx spikes/mcp-oauth/spike.ts`.)
 *
 * It prints an authorize URL; open it, consent in the browser, and the local callback captures the code and
 * exchanges it for tokens. On success it lists the server's tools using the obtained access token, then exits.
 * Tokens + client registration are written to `.spike-oauth-state.json` (gitignored) so a re-run exercises the
 * refresh path with no second consent.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const MCP_URL = process.env['MCP_URL'] ?? 'https://mcp.atlassian.com/v1/sse';
const PORT = Number(process.env['SPIKE_PORT'] ?? 45678);
const REDIRECT_URL = `http://localhost:${PORT}/callback`;
const STATE_FILE = join(__dirname, '.spike-oauth-state.json');

interface SpikeState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function loadState(): SpikeState {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}
function saveState(s: SpikeState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** The OAuthClientProvider — the exact seam the production impl will fill (file-backed here, DB-backed there). */
class SpikeOAuthProvider implements OAuthClientProvider {
  private store: SpikeState = loadState();
  /** Set by the callback server once the authorize redirect lands, so `redirectToAuthorization` can print it. */
  onAuthorizeUrl?: (url: URL) => void;

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    // The DCR request body. `redirect_uris` is the load-bearing field: WE declare the loopback URI here, so
    // the authorize step's redirect_uri matches what the provider just stored — the "mismatch" can't happen.
    return {
      client_name: 'Atlas MCP OAuth spike',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE (no client secret)
      scope: process.env['MCP_SCOPE'] ?? undefined,
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.store.clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.store.clientInformation = info;
    saveState(this.store);
    console.log(`[spike] DCR ok — registered client_id=${info.client_id} redirect_uri=${REDIRECT_URL}`);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.store.tokens = tokens;
    saveState(this.store);
    console.log(`[spike] tokens saved — has refresh_token=${!!tokens.refresh_token}, expires_in=${tokens.expires_in}`);
  }

  redirectToAuthorization(url: URL): void {
    this.onAuthorizeUrl?.(url);
  }

  saveCodeVerifier(v: string): void {
    this.store.codeVerifier = v;
    saveState(this.store);
  }
  codeVerifier(): string {
    if (!this.store.codeVerifier) throw new Error('no PKCE code verifier saved');
    return this.store.codeVerifier;
  }
}

/** Wait for the OAuth provider to redirect back to our loopback callback; resolve with the auth code. */
function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<h2>${code ? 'Authorized — you can close this tab.' : `Error: ${err}`}</h2>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(`authorization failed: ${err ?? 'no code returned'}`));
    });
    server.listen(PORT, () => console.log(`[spike] callback server listening on ${REDIRECT_URL}`));
    server.on('error', reject);
  });
}

async function listToolsWithToken(provider: SpikeOAuthProvider): Promise<void> {
  const client = new Client({ name: 'atlas-oauth-spike', version: '0.0.0' }, { capabilities: {} });
  const tryTransport = async (kind: 'http' | 'sse'): Promise<boolean> => {
    try {
      const transport =
        kind === 'http'
          ? new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider })
          : new SSEClientTransport(new URL(MCP_URL), { authProvider: provider });
      await client.connect(transport);
      const tools = await client.listTools();
      console.log(`[spike] ✅ connected via ${kind} — ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).slice(0, 8).join(', ')}${tools.tools.length > 8 ? ', …' : ''}`);
      await client.close();
      return true;
    } catch (e) {
      console.log(`[spike] ${kind} transport failed: ${(e as Error).message}`);
      return false;
    }
  };
  if (!(await tryTransport('http'))) await tryTransport('sse');
}

async function main(): Promise<void> {
  console.log(`[spike] MCP server: ${MCP_URL}`);
  const provider = new SpikeOAuthProvider();

  // If we already have tokens from a prior run, skip straight to using them (exercises refresh via the SDK).
  if (provider.tokens()) {
    console.log('[spike] existing tokens found — skipping consent, testing token use/refresh…');
    await listToolsWithToken(provider);
    return;
  }

  const callbackPromise = waitForCallback();
  provider.onAuthorizeUrl = (url) => {
    console.log(`\n[spike] OPEN THIS URL TO CONSENT:\n${url.toString()}\n`);
    spawn('open', [url.toString()], { stdio: 'ignore' }).on('error', () => {
      /* not macOS / no `open` — the user opens the printed URL manually */
    });
  };

  // First auth() call: discovery → DCR (declares our loopback redirect_uri) → startAuthorization → REDIRECT.
  const first = await auth(provider, { serverUrl: MCP_URL });
  console.log(`[spike] auth() phase 1 => ${first}`); // expect 'REDIRECT'
  if (first !== 'REDIRECT') {
    console.log('[spike] unexpected: no redirect required — nothing to prove about the callback.');
    return;
  }

  const code = await callbackPromise;
  console.log(`[spike] callback received code (len=${code.length}) at ${REDIRECT_URL} — NO redirect_uri mismatch.`);

  // Second auth() call with the code: exchangeAuthorization → saveTokens → AUTHORIZED.
  const second = await auth(provider, { serverUrl: MCP_URL, authorizationCode: code });
  console.log(`[spike] auth() phase 2 => ${second}`); // expect 'AUTHORIZED'

  await listToolsWithToken(provider);
  console.log('\n[spike] DONE — DCR-registered loopback callback round-tripped cleanly. Theory confirmed.');
}

main().catch((e) => {
  console.error('[spike] FAILED:', e);
  process.exit(1);
});
