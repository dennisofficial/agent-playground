import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { CLI_IDENTITY, type Identity } from '../domain/identity';
import { FetchService } from './fetch.service';
import type { SemanticMemory } from './semantic-memory';
import type { TaskStore } from './task-store';
import type { BoardStore } from './board-store';
import type { Task } from './task-store';
import type { BoardTask } from './board-store';

/** Minimal EmployeeDefinition for tests. */
const makeBot = (overrides: Partial<EmployeeDefinition> = {}): EmployeeDefinition => ({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 1,
  roleContext: '',
  engine: EWorkerEngineName.CLAUDE,
  ...overrides,
});

const id: Identity = { ...CLI_IDENTITY };

/** Build a FetchService with mocked dependencies. */
function makeService(opts: {
  prefs?: string;
  boardTasks?: BoardTask[];
  reminders?: Task[];
}) {
  const semantic = {
    standingContext: vi.fn().mockResolvedValue(opts.prefs ?? ''),
  } as unknown as SemanticMemory;

  const tasks = {
    listTasks: vi.fn().mockResolvedValue(opts.reminders ?? []),
    openTasks: vi.fn().mockResolvedValue(opts.reminders ?? []),
  } as unknown as TaskStore;

  const board = {
    list: vi.fn().mockResolvedValue(opts.boardTasks ?? []),
  } as unknown as BoardStore;

  return { svc: new FetchService(semantic, tasks, board), semantic, tasks, board };
}

describe('FetchService.fetchContext (Phase 3 assembler)', () => {
  describe('standing-context core', () => {
    it('always includes role and project even when the team store is empty', async () => {
      const { svc } = makeService({ prefs: '' });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Standing context:');
      expect(result).toContain('backend engineer');
      expect(result).toContain(id.project);
    });

    it('appends standing prefs when present (≤5)', async () => {
      const prefs = [
        '- Dennis prefers PRs to target develop',
        '- Use Postgres across all services',
        '- Staging is rebuilt nightly at 02:00',
      ].join('\n');
      const { svc } = makeService({ prefs });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Dennis prefers PRs');
      expect(result).toContain('Postgres');
    });

    it('calls standingContext with limit 5', async () => {
      const { svc, semantic } = makeService({});
      await svc.fetchContext(makeBot(), id);
      expect(semantic.standingContext).toHaveBeenCalledWith(id, 5);
    });

    it('degrades gracefully when standingContext throws (still emits role/project)', async () => {
      const semantic = {
        standingContext: vi.fn().mockRejectedValue(new Error('db error')),
      } as unknown as SemanticMemory;
      const tasks = { listTasks: vi.fn().mockResolvedValue([]), openTasks: vi.fn().mockResolvedValue([]) } as unknown as TaskStore;
      const board = { list: vi.fn().mockResolvedValue([]) } as unknown as BoardStore;
      const svc = new FetchService(semantic, tasks, board);
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Standing context:');
      expect(result).toContain('backend engineer');
    });
  });

  describe('bulk recall blocks are GONE', () => {
    it('never contains "What you already know" block', async () => {
      const { svc } = makeService({ prefs: 'some pref' });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('What you already know');
    });

    it('never contains "From other projects" block', async () => {
      const { svc } = makeService({ prefs: 'some pref' });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('From other projects');
    });

    it('does NOT call semantic.recall or semantic.recallOtherProjects', async () => {
      const { svc, semantic } = makeService({});
      await svc.fetchContext(makeBot(), id);
      // SemanticMemory.recall / recallOtherProjects must not be called
      expect((semantic as Record<string, unknown>).recall).toBeUndefined();
      expect((semantic as Record<string, unknown>).recallOtherProjects).toBeUndefined();
    });
  });

  describe('active board tasks slot', () => {
    it('renders in-progress board tasks when present', async () => {
      const boardTasks: BoardTask[] = [
        { id: 10, title: 'Build auth API', description: '', status: 'in_progress', project: 'main', assignee: 'alex', createdBy: 'sam', dependsOn: [], createdAt: '', updatedAt: '' },
      ];
      const { svc } = makeService({ boardTasks });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Active board work:');
      expect(result).toContain('[#10] Build auth API');
    });

    it('omits the board section when there are no in-progress tasks', async () => {
      const { svc } = makeService({ boardTasks: [] });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('Active board work:');
    });

    it('caps at BOARD_TASK_CAP (5) and shows overflow note', async () => {
      const boardTasks: BoardTask[] = Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        status: 'in_progress' as const,
        project: 'main',
        assignee: 'alex',
        createdBy: 'sam',
        dependsOn: [],
        createdAt: '',
        updatedAt: '',
      }));
      const { svc } = makeService({ boardTasks });
      const result = await svc.fetchContext(makeBot(), id);
      // Should cap at 5, show 2 more note
      expect(result).toContain('…and 2 more (list_board)');
    });

    it('degrades gracefully when board.list throws', async () => {
      const semantic = { standingContext: vi.fn().mockResolvedValue('') } as unknown as SemanticMemory;
      const tasks = { listTasks: vi.fn().mockResolvedValue([]), openTasks: vi.fn().mockResolvedValue([]) } as unknown as TaskStore;
      const board = { list: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as BoardStore;
      const svc = new FetchService(semantic, tasks, board);
      const result = await svc.fetchContext(makeBot(), id);
      // Should still return standing context, no board section
      expect(result).toContain('Standing context:');
      expect(result).not.toContain('Active board work:');
    });
  });

  describe('reminder plate slot', () => {
    it('renders open reminders when present', async () => {
      const reminders: Task[] = [
        { id: 1, project: 'local', description: 'Wire the auth hooks', owner: 'alex', status: 'open', createdAt: '', updatedAt: '' },
      ];
      const { svc } = makeService({ reminders });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('On your plate:');
      expect(result).toContain('[#1] Wire the auth hooks');
    });

    it('omits reminders section when plate is empty', async () => {
      const { svc } = makeService({ reminders: [] });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('On your plate:');
    });

    it('caps at REMINDER_CAP (12) and shows overflow count', async () => {
      const reminders: Task[] = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        project: 'local',
        description: `Reminder ${i + 1}`,
        owner: 'alex',
        status: 'open' as const,
        createdAt: '',
        updatedAt: '',
      }));
      const { svc } = makeService({ reminders });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('…and 3 more');
    });

    it('uses "Open reminders (team):" label for the team lead', async () => {
      const reminders: Task[] = [
        { id: 1, project: 'local', description: 'Team task', owner: 'riley', status: 'open', createdAt: '', updatedAt: '' },
      ];
      const { svc } = makeService({ reminders });
      const result = await svc.fetchContext(makeBot({ teamLead: true }), id);
      expect(result).toContain('Open reminders (team):');
    });
  });

  describe('section ordering and structure', () => {
    it('sections appear in priority order: standing → board → reminders', async () => {
      const boardTasks: BoardTask[] = [
        { id: 5, title: 'Board job', description: '', status: 'in_progress', project: 'main', assignee: 'alex', createdBy: 'sam', dependsOn: [], createdAt: '', updatedAt: '' },
      ];
      const reminders: Task[] = [
        { id: 1, project: 'local', description: 'Do a thing', owner: 'alex', status: 'open', createdAt: '', updatedAt: '' },
      ];
      const { svc } = makeService({
        prefs: '- Prefer TypeScript strict mode',
        boardTasks,
        reminders,
      });
      const result = await svc.fetchContext(makeBot(), id);
      const standingIdx = result.indexOf('Standing context:');
      const boardIdx = result.indexOf('Active board work:');
      const remindersIdx = result.indexOf('On your plate:');
      expect(standingIdx).toBeGreaterThanOrEqual(0);
      expect(boardIdx).toBeGreaterThanOrEqual(0);
      expect(remindersIdx).toBeGreaterThanOrEqual(0);
      expect(standingIdx).toBeLessThan(boardIdx);
      expect(boardIdx).toBeLessThan(remindersIdx);
    });

    it('returns a non-empty string even with all empty stores (role/project always rendered)', async () => {
      const { svc } = makeService({});
      const result = await svc.fetchContext(makeBot(), id);
      expect(result.trim().length).toBeGreaterThan(0);
      expect(result).toContain('Standing context:');
    });
  });
});
