import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { TENANT_PROVISIONER } from '../src/gateway/orchestrator/stack-orchestrator.port';
import { GatewayModule } from '../src/gateway/gateway.module';
import { TenantStore } from '../src/gateway/tenants/tenant.store';
import { SecretCipher } from '../src/harness/projects/secret-cipher';

/**
 * The manual tenant-provisioning trigger — SAME codepath as the OAuth install hook
 * (TenantProvisionerService), so the scripted interim flow and the automated flow can't drift.
 *
 *   pnpm tenant:provision T0XXXXXXX                # tenant row exists (OAuth already ran)
 *   pnpm tenant:provision -- --team T0XXXXXXX --name "Mom's workspace" --token xoxb-…
 *                                                  # fully manual (app-per-workspace interim)
 *
 * Needs the gateway env (control DB + SECRETS_ENCRYPTION_KEY + GATEWAY_SHARED_SECRET) — runs
 * under `pnpm env:inject` like every other CLI.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const teamId = flag('team') ?? args.find((a) => !a.startsWith('--'));
  const token = flag('token');
  const name = flag('name');
  if (!teamId) {
    console.error(
      'Usage: pnpm tenant:provision <teamId>\n' +
        '       pnpm tenant:provision -- --team <teamId> --name <displayName> --token xoxb-…',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(GatewayModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    if (token) {
      const tenants = app.get(TenantStore);
      const cipher = app.get(SecretCipher);
      await tenants.upsertFromOauth({
        teamId,
        teamName: name ?? teamId,
        botTokenCiphertext: cipher.encrypt(token),
      });
      console.log(`tenant ${teamId} upserted from CLI input`);
    }
    const provisioner = app.get<{ provision(teamId: string): Promise<{ stackBaseUrl: string }> }>(
      TENANT_PROVISIONER,
    );
    const stack = await provisioner.provision(teamId);
    console.log(`\nDONE — tenant ${teamId} routed to ${stack.stackBaseUrl}`);
    console.log('Start the stack with the command printed above, then watch the gateway forward.');
  } finally {
    await app.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
