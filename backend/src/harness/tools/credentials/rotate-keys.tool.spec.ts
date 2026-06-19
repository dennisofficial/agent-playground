import { describe, expect, it, vi } from 'vitest';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import type { RotateKeysPresenter } from '../../llm-keys/rotate-keys-presenter.port';
import type { HarnessToolContext } from '../tool.types';
import { RotateKeysTool } from './rotate-keys.tool';

const ctx = (selfAgent: string): HarnessToolContext =>
  ({
    identity: { selfAgent, team: 'T1', surface: 'slack:T1:C1', project: 'p' },
  }) as unknown as HarnessToolContext;

const employees = (lead: boolean): EmployeeRegistry =>
  ({ byId: () => ({ teamLead: lead }) }) as unknown as EmployeeRegistry;

describe('RotateKeysTool', () => {
  it('is lead-only', async () => {
    const present = vi.fn();
    const tool = new RotateKeysTool(employees(false), {
      present,
    } as RotateKeysPresenter);
    const out = await tool.execute({ reason: 'x' }, ctx('atlas'));
    expect(out).toMatch(/team lead/i);
    expect(present).not.toHaveBeenCalled();
  });

  it('presents the card with the team/surface/reason/suspected (no secret)', async () => {
    const present = vi.fn(async () => undefined);
    const tool = new RotateKeysTool(employees(true), {
      present,
    } as RotateKeysPresenter);
    const out = await tool.execute(
      { reason: 'Codex 401', suspected: ['Codex subscription'] },
      ctx('atlas'),
    );
    expect(present).toHaveBeenCalledWith({
      team: 'T1',
      surfaceId: 'slack:T1:C1',
      reason: 'Codex 401',
      suspected: ['Codex subscription'],
    });
    expect(out).toMatch(/posted an update-keys card/i);
  });

  it('degrades to chat-words when no presenter is bound (headless)', async () => {
    const tool = new RotateKeysTool(employees(true), undefined);
    const out = await tool.execute({ reason: 'x' }, ctx('atlas'));
    expect(out).toMatch(/no Slack surface|admin API/i);
  });

  it('reports a present() failure without throwing', async () => {
    const present = vi.fn(async () => {
      throw new Error('slack down');
    });
    const tool = new RotateKeysTool(employees(true), {
      present,
    } as RotateKeysPresenter);
    const out = await tool.execute({ reason: 'x' }, ctx('atlas'));
    expect(out).toMatch(/couldn't post|admin API/i);
  });
});
