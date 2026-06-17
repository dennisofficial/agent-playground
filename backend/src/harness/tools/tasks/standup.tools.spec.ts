import type { Identity } from '../../domain/identity';
import { CloseStandupTool, OpenStandupTool } from './standup.tools';

const identity = (selfAgent: string): { identity: Identity } => ({
  identity: {
    selfAgent,
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'chan',
    isChannel: true,
  },
});

function makeFakes() {
  const settings = { setStandupOpen: vi.fn(() => Promise.resolve()) };
  const employees = {
    byId: (id: string) =>
      ['atlas', 'alex'].includes(id)
        ? { id, name: id, teamLead: id === 'atlas' }
        : undefined,
  };
  return { settings, employees };
}

describe('standup tools', () => {
  it('open/close are lead-only and flip the team flag', async () => {
    const f = makeFakes();
    const open = new OpenStandupTool(f.settings as never, f.employees as never);
    const close = new CloseStandupTool(
      f.settings as never,
      f.employees as never,
    );

    expect(await open.execute({}, identity('alex'))).toContain(
      "team lead's call",
    );
    expect(await close.execute({}, identity('alex'))).toContain(
      "team lead's call",
    );
    expect(f.settings.setStandupOpen).not.toHaveBeenCalled();

    expect(await open.execute({}, identity('atlas'))).toContain('Standup OPEN');
    expect(f.settings.setStandupOpen).toHaveBeenLastCalledWith('T1', true);
    expect(await close.execute({}, identity('atlas'))).toContain(
      'Standup CLOSED',
    );
    expect(f.settings.setStandupOpen).toHaveBeenLastCalledWith('T1', false);
  });
});
