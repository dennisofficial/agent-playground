import { describe, expect, it, vi } from 'vitest';
import type { ConductorService } from '@harness/conductor/conductor.service';
import type { EmployeeRegistry } from '@harness/employees/employee.registry';
import { CredentialRotationBus } from '@harness/llm-keys/credential-rotation.bus';
import type { LlmReadinessService } from '@harness/llm-keys/llm-readiness.service';
import type { ProviderKeyStore } from '@harness/llm-keys/provider-key.store';
import type { EnvService } from '@core/config/env/env.service';
import type { TenantStore } from '../tenant.store';
import type { TenantSlackClients } from '../tenant-slack-clients';
import type { SlackInbound } from '../slack-inbound.types';
import { ROTATE_MODAL_CALLBACK_ID } from './rotate-keys-blocks';
import { RotateKeysCardsService } from './rotate-keys-cards.service';

const BOSS = 'U_BOSS';
const META = JSON.stringify({
  team: 'T1',
  channel: 'C1',
  surfaceId: 'slack:T1:C1',
  cardTs: 'ts1',
});

function build() {
  const put = vi.fn(async () => ({}) as never);
  const putSubscription = vi.fn(async () => ({}) as never);
  const providerKeys = { put, putSubscription } as unknown as ProviderKeyStore;
  const refresh = vi.fn(async () => true);
  const readiness = { refresh } as unknown as LlmReadinessService;
  const rotation = new CredentialRotationBus();
  const emit = vi.spyOn(rotation, 'emit');
  const injectSeed = vi.fn();
  const conductor = { injectSeed } as unknown as ConductorService;
  const employees = {
    teamLead: () => ({ id: 'atlas', name: 'Atlas' }),
  } as unknown as EmployeeRegistry;
  const tenants = {
    get: async () => ({ installedBy: BOSS }),
  } as unknown as TenantStore;
  const env = { get: () => undefined } as unknown as EnvService;
  const update = vi.fn(async () => undefined);
  const clients = {
    clientFor: async () => ({ chat: { update } }),
  } as unknown as TenantSlackClients;

  const svc = new RotateKeysCardsService(
    clients,
    tenants,
    employees,
    providerKeys,
    readiness,
    rotation,
    conductor,
    env,
  );
  return { svc, put, putSubscription, emit, refresh, injectSeed };
}

function submission(
  values: Record<string, string>,
  user = BOSS,
): { item: Extract<SlackInbound, { kind: 'interactivity' }>; respond: ReturnType<typeof vi.fn> } {
  const state: Record<string, Record<string, { value: string }>> = {};
  // block_id → { value: { value } } (action_id is always 'value' for the rotate modal).
  for (const [blockId, v] of Object.entries(values))
    state[blockId] = { value: { value: v } };
  const respond = vi.fn(async () => undefined);
  const item = {
    kind: 'interactivity',
    payload: {
      type: 'view_submission',
      user: { id: user },
      view: {
        callback_id: ROTATE_MODAL_CALLBACK_ID,
        private_metadata: META,
        state: { values: state },
      },
    },
    respond,
  } as unknown as Extract<SlackInbound, { kind: 'interactivity' }>;
  return { item, respond };
}

describe('RotateKeysCardsService.maybeHandle (submission)', () => {
  it('stores only the filled fields (put vs putSubscription), then fans out + refreshes', async () => {
    const { svc, put, putSubscription, emit, refresh, injectSeed } = build();
    const { item, respond } = submission({
      anthropic_key: 'sk-ant-abcdefgh12345',
      openai_sub: '{"tokens":{"access":"x"}}',
    });
    expect(await svc.maybeHandle(item)).toBe(true);
    expect(put).toHaveBeenCalledWith('T1', 'anthropic', 'sk-ant-abcdefgh12345');
    expect(put).toHaveBeenCalledTimes(1); // openai API key NOT touched (blank)
    expect(putSubscription).toHaveBeenCalledWith(
      'T1',
      'openai',
      'subscription',
      '{"tokens":{"access":"x"}}',
    );
    expect(emit).toHaveBeenCalledWith('T1');
    expect(refresh).toHaveBeenCalledWith('T1');
    expect(injectSeed).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(); // modal closed, no errors
  });

  it('rejects a malformed API key with a field error and stores nothing', async () => {
    const { svc, put, emit } = build();
    const { item, respond } = submission({ anthropic_key: 'not-a-key' });
    await svc.maybeHandle(item);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_action: 'errors' }),
    );
    expect(put).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects an empty submission (no field filled)', async () => {
    const { svc, put } = build();
    const { item, respond } = submission({});
    await svc.maybeHandle(item);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_action: 'errors' }),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a non-boss submitter', async () => {
    const { svc, put } = build();
    const { item, respond } = submission(
      { anthropic_key: 'sk-ant-abcdefgh12345' },
      'U_INTRUDER',
    );
    await svc.maybeHandle(item);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ response_action: 'errors' }),
    );
    expect(put).not.toHaveBeenCalled();
  });
});
