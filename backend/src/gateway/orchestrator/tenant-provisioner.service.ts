import { SecretCipher } from '@harness/projects/secret-cipher';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantStore } from '../tenants/tenant.store';
import {
  STACK_ORCHESTRATOR,
  type ProvisionedStack,
  type StackOrchestrator,
  type TenantProvisioner,
} from './stack-orchestrator.port';

/**
 * The one provisioning codepath — the OAuth install hook and the `pnpm tenant:provision` CLI both
 * land here, so the automated and manual shapes can't drift. This is also the single place the
 * bot token is decrypted: it flows straight into the orchestrator's env overlay, never into logs
 * or responses.
 */
@Injectable()
export class TenantProvisionerService implements TenantProvisioner {
  private readonly logger = new Logger(TenantProvisionerService.name);

  constructor(
    private readonly tenants: TenantStore,
    private readonly cipher: SecretCipher,
    @Inject(STACK_ORCHESTRATOR) private readonly orchestrator: StackOrchestrator,
  ) {}

  async provision(teamId: string): Promise<ProvisionedStack> {
    const tenant = await this.tenants.get(teamId);
    if (!tenant) throw new Error(`No tenant ${teamId} — has the app been installed there?`);
    const ciphertext = await this.tenants.resolveBotTokenCiphertext(teamId);
    if (!ciphertext) throw new Error(`Tenant ${teamId} has no stored bot token.`);

    const stack = await this.orchestrator.provision({
      teamId,
      teamName: tenant.teamName,
      botToken: this.cipher.decrypt(ciphertext),
    });
    await this.tenants.setStack(teamId, stack.stackBaseUrl);
    this.logger.log(`tenant ${teamId} routed to ${stack.stackBaseUrl}`);
    return stack;
  }
}
