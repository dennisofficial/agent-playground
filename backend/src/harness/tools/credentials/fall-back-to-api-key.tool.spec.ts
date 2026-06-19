import { describe, expect, it, vi } from 'vitest';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import { CredentialRotationBus } from '../../llm-keys/credential-rotation.bus';
import type { ProviderKeyStore } from '../../llm-keys/provider-key.store';
import type { TenantCredentialService } from '../../llm-keys/tenant-credential.service';
import type { HarnessToolContext } from '../tool.types';
import { FallBackToApiKeyTool } from './fall-back-to-api-key.tool';

const ctx = (selfAgent: string): HarnessToolContext =>
  ({
    identity: { selfAgent, team: 'T1', surface: 'slack:T1:C1', project: 'p' },
  }) as unknown as HarnessToolContext;

const employees = (lead: boolean): EmployeeRegistry =>
  ({ byId: () => ({ teamLead: lead }) }) as unknown as EmployeeRegistry;

function make(opts: { lead?: boolean; apiKey?: string } = {}) {
  const putSubscription = vi.fn(async () => ({}) as never);
  const keyStore = { putSubscription } as unknown as ProviderKeyStore;
  const creds = {
    resolve: async () => ({ openai: opts.apiKey, anthropic: opts.apiKey }),
  } as unknown as TenantCredentialService;
  const rotation = new CredentialRotationBus();
  const emit = vi.spyOn(rotation, 'emit');
  const tool = new FallBackToApiKeyTool(
    employees(opts.lead ?? true),
    keyStore,
    creds,
    rotation,
  );
  return { tool, putSubscription, emit };
}

describe('FallBackToApiKeyTool', () => {
  it('is lead-only', async () => {
    const { tool, putSubscription } = make({ lead: false, apiKey: 'sk' });
    const out = await tool.execute({ provider: 'openai' }, ctx('atlas'));
    expect(out).toMatch(/team lead/i);
    expect(putSubscription).not.toHaveBeenCalled();
  });

  it('flips the provider to api_key mode (keeping the secret) and fans out the rotation', async () => {
    const { tool, putSubscription, emit } = make({ apiKey: 'sk-oai' });
    const out = await tool.execute({ provider: 'openai' }, ctx('atlas'));
    // secret omitted → putSubscription keeps the stored token, only flips the mode.
    expect(putSubscription).toHaveBeenCalledWith('T1', 'openai', 'api_key');
    expect(emit).toHaveBeenCalledWith('T1');
    expect(out).toMatch(/metered API key/i);
  });

  it('refuses when there is no API key to fall back to', async () => {
    const { tool, putSubscription } = make({ apiKey: undefined });
    const out = await tool.execute({ provider: 'anthropic' }, ctx('atlas'));
    expect(out).toMatch(/no .*API key|add one first/i);
    expect(putSubscription).not.toHaveBeenCalled();
  });
});
