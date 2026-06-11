import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import type {
  ProvisionedStack,
  StackOrchestrator,
  TenantStackSpec,
} from './stack-orchestrator.port';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT_BASE = 4200;

/**
 * The v1 orchestrator binding: materializes everything a tenant stack needs — per-tenant env
 * overlay, tenant database (created + migrated), worker/repos jails — and PRINTS the run command
 * instead of starting a process (Dennis runs stacks by hand until the deploy pass lands; the
 * ComposeOrchestrator that replaces this must satisfy the same contract, and THE OVERLAY WRITTEN
 * HERE IS THAT CONTRACT).
 *
 * Idempotent re-provision: an existing overlay keeps its port and minted secrets (the stack's
 * SECRETS_ENCRYPTION_KEY must never rotate behind its data) — only the bot token refreshes
 * (reinstall = token rotation; restart the stack to pick it up).
 */
@Injectable()
export class ManualOrchestrator implements StackOrchestrator {
  private readonly logger = new Logger(ManualOrchestrator.name);

  constructor(
    private readonly env: EnvService,
    @InjectDataSource() private readonly control: DataSource,
  ) {}

  async provision(spec: TenantStackSpec): Promise<ProvisionedStack> {
    const root = this.tenantRoot();
    await mkdir(root, { recursive: true });
    const overlayPath = join(root, `${spec.teamId}.env`);
    const existing = await readOverlay(overlayPath);

    const dbName = `tenant_${spec.teamId.toLowerCase()}`;
    if (!/^[a-z0-9_]+$/.test(dbName)) {
      throw new Error(`team id ${spec.teamId} does not slug into a safe database name`);
    }
    const port = Number(existing?.SLACK_INBOUND_PORT ?? (await this.allocatePort(root)));
    const secretsKey =
      existing?.SECRETS_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
    const adminToken = existing?.ADMIN_API_TOKEN ?? randomBytes(24).toString('hex');
    if (existing && existing.SLACK_BOT_TOKEN !== spec.botToken) {
      this.logger.warn(
        `tenant ${spec.teamId}: bot token changed (reinstall) — overlay rewritten; restart the stack to pick it up`,
      );
    }

    const workerRoot = join(root, spec.teamId, 'worker');
    const reposRoot = join(root, spec.teamId, 'repos');
    await mkdir(workerRoot, { recursive: true });
    await mkdir(reposRoot, { recursive: true });

    await this.ensureDatabase(dbName);
    await this.migrate(dbName);

    // THE ENV-OVERLAY CONTRACT (what a ComposeOrchestrator must reproduce). LLM keys are
    // intentionally ABSENT — they arrive at runtime via Jarvis → provider_keys (pending-keys boot).
    const overlay: Record<string, string | number | undefined> = {
      APP_ENV: this.env.get('APP_ENV'),
      NODE_ENV: this.env.get('NODE_ENV'),
      SLACK_INBOUND: 'gateway',
      SLACK_BOT_TOKEN: spec.botToken, // plaintext file = accepted v1 risk (deploy pass: secret store)
      SLACK_INBOUND_PORT: port,
      GATEWAY_SHARED_SECRET: this.env.get('GATEWAY_SHARED_SECRET'),
      HARNESS_TEAM_ID: spec.teamId, // Slack team id = tenant id = memory team tier
      HARNESS_SURFACE_ID: `slack:home:${spec.teamId}`, // synthetic default room, never 'tui:main'
      POSTGRES_HOST: this.env.get('POSTGRES_HOST'),
      POSTGRES_PORT: this.env.get('POSTGRES_PORT'),
      POSTGRES_USER: this.env.get('POSTGRES_USER'),
      POSTGRES_PASSWORD: this.env.get('POSTGRES_PASSWORD'),
      POSTGRES_DB: dbName,
      SECRETS_ENCRYPTION_KEY: secretsKey,
      ADMIN_API_TOKEN: adminToken,
      WORKER_ROOT: workerRoot,
      REPOS_ROOT: reposRoot,
      AVATAR_BASE_URL: this.env.get('AVATAR_BASE_URL'),
      AVATAR_STYLE: this.env.get('AVATAR_STYLE'),
    };
    const content = Object.entries(overlay)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    await writeFile(overlayPath, `${content}\n`, { mode: 0o600 });

    const runCmd = `dotenvx run -f ${overlayPath} --overload -- node dist/slack-app/main`;
    this.logger.log(
      `tenant ${spec.teamId} provisioned — overlay ${overlayPath}, db ${dbName}, port ${port}.\n` +
        `  START THE STACK (from backend/): ${runCmd}`,
    );
    return { stackBaseUrl: `http://127.0.0.1:${port}` };
  }

  async suspend(teamId: string): Promise<void> {
    this.logger.warn(`tenant ${teamId} suspended — stop its stack process manually`);
  }

  async resume(teamId: string): Promise<ProvisionedStack> {
    const existing = await readOverlay(join(this.tenantRoot(), `${teamId}.env`));
    if (!existing?.SLACK_INBOUND_PORT) {
      throw new Error(`tenant ${teamId} has no overlay — provision it first`);
    }
    this.logger.log(`tenant ${teamId}: restart its stack manually (see the overlay)`);
    return { stackBaseUrl: `http://127.0.0.1:${existing.SLACK_INBOUND_PORT}` };
  }

  async status(): Promise<'running' | 'stopped' | 'unknown'> {
    return 'unknown'; // manual processes — the orchestrator doesn't own their lifecycle
  }

  private tenantRoot(): string {
    return (
      this.env.get('TENANT_ENV_ROOT') ?? join(homedir(), '.agent-playground', 'tenants')
    );
  }

  /** Stable, collision-free: one above the highest port any existing overlay claims. */
  private async allocatePort(root: string): Promise<number> {
    const base = this.env.get('TENANT_PORT_BASE') ?? DEFAULT_PORT_BASE;
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(root).catch(() => [])).filter((f) => f.endsWith('.env'));
    let max = base - 1;
    for (const f of files) {
      const parsed = await readOverlay(join(root, f));
      const p = Number(parsed?.SLACK_INBOUND_PORT);
      if (Number.isFinite(p)) max = Math.max(max, p);
    }
    return max + 1;
  }

  private async ensureDatabase(dbName: string): Promise<void> {
    const rows = (await this.control.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    )) as unknown[];
    if (rows.length === 0) {
      // Identifier interpolation is safe — dbName is regex-validated above.
      await this.control.query(`CREATE DATABASE "${dbName}"`);
      this.logger.log(`created database ${dbName}`);
    }
  }

  /** Harness migrations against the tenant DB. `db:migrate:ambient` deliberately skips
   * env:inject — the encrypted env files would clobber the per-tenant overrides we pass here.
   * Runs from the backend package dir (dev/OVH both run the gateway from a repo checkout). */
  private async migrate(dbName: string): Promise<void> {
    await execFileAsync('pnpm', ['db:migrate:ambient'], {
      cwd: process.cwd(),
      env: { ...process.env, POSTGRES_DB: dbName },
    });
    this.logger.log(`migrated ${dbName}`);
  }
}

/** Parse a KEY=VALUE overlay (no quoting/escaping — we write it, we read it). */
async function readOverlay(path: string): Promise<Record<string, string> | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  } catch {
    return undefined;
  }
}
