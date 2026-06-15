import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmployeeDefinition } from '../employees/employee.types';
import { makeEmployee } from '../employees/employee.testing';
import { CLI_IDENTITY, type Identity } from '../domain/identity';
import { FetchService } from './fetch.service';
import type { SemanticMemory } from './semantic-memory';
import type { TaskStore } from './task-store';
import type { BoardStore } from './board-store';
import type { SessionNoteStore } from './session-note.store';
import type { Task } from './task-store';
import type { BoardTask } from './board-store';
import type { SessionNote } from './session-note.store';

/** Minimal EmployeeDefinition for tests. */
const makeBot = (
  overrides: Partial<EmployeeDefinition> = {},
): EmployeeDefinition => ({
  ...makeEmployee({
    id: 'alex',
    name: 'Alex',
    role: 'backend engineer',
    sortOrder: 1,
    roleContext: '',
  }),
  ...overrides,
});

const id: Identity = { ...CLI_IDENTITY };

/** Build a FetchService with mocked dependencies. */
function makeService(opts: {
  prefs?: string;
  boardTasks?: BoardTask[];
  reminders?: Task[];
  openNotes?: SessionNote[];
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

  const sessionNotes = {
    listOpen: vi.fn().mockResolvedValue(opts.openNotes ?? []),
  } as unknown as SessionNoteStore;

  return {
    svc: new FetchService(semantic, tasks, board, sessionNotes),
    semantic,
    tasks,
    board,
    sessionNotes,
  };
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

    it('calls standingContext with the conversation id', async () => {
      const { svc, semantic } = makeService({});
      await svc.fetchContext(makeBot(), id);
      expect(semantic.standingContext).toHaveBeenCalledWith(id);
    });

    it('degrades gracefully when standingContext throws (still emits role/project)', async () => {
      const semantic = {
        standingContext: vi.fn().mockRejectedValue(new Error('db error')),
      } as unknown as SemanticMemory;
      const tasks = {
        listTasks: vi.fn().mockResolvedValue([]),
        openTasks: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;
      const board = {
        list: vi.fn().mockResolvedValue([]),
      } as unknown as BoardStore;
      const sessionNotes = {
        listOpen: vi.fn().mockResolvedValue([]),
      } as unknown as SessionNoteStore;
      const svc = new FetchService(semantic, tasks, board, sessionNotes);
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
      expect(
        (semantic as unknown as Record<string, unknown>).recall,
      ).toBeUndefined();
      expect(
        (semantic as unknown as Record<string, unknown>).recallOtherProjects,
      ).toBeUndefined();
    });
  });

  describe('active board tasks slot', () => {
    it('renders in-progress board tasks when present', async () => {
      const boardTasks: BoardTask[] = [
        {
          id: 10,
          title: 'Build auth API',
          description: '',
          status: 'executing',
          project: 'main',
          assignee: 'alex',
          createdBy: 'sam',
          dependsOn: [],
          createdAt: '',
          updatedAt: '',
        },
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
        status: 'executing' as const,
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
      const semantic = {
        standingContext: vi.fn().mockResolvedValue(''),
      } as unknown as SemanticMemory;
      const tasks = {
        listTasks: vi.fn().mockResolvedValue([]),
        openTasks: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;
      const board = {
        list: vi.fn().mockRejectedValue(new Error('db down')),
      } as unknown as BoardStore;
      const sessionNotes = {
        listOpen: vi.fn().mockResolvedValue([]),
      } as unknown as SessionNoteStore;
      const svc = new FetchService(semantic, tasks, board, sessionNotes);
      const result = await svc.fetchContext(makeBot(), id);
      // Should still return standing context, no board section
      expect(result).toContain('Standing context:');
      expect(result).not.toContain('Active board work:');
    });
  });

  describe('reminder plate slot', () => {
    it('renders open reminders when present', async () => {
      const reminders: Task[] = [
        {
          id: 1,
          project: 'local',
          description: 'Wire the auth hooks',
          owner: 'alex',
          status: 'open',
          createdAt: '',
          updatedAt: '',
        },
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
        {
          id: 1,
          project: 'local',
          description: 'Team task',
          owner: 'riley',
          status: 'open',
          createdAt: '',
          updatedAt: '',
        },
      ];
      const { svc } = makeService({ reminders });
      const result = await svc.fetchContext(makeBot({ teamLead: true }), id);
      expect(result).toContain('Open reminders (team):');
    });
  });

  describe('section ordering and structure', () => {
    it('sections appear in priority order: standing → board → reminders', async () => {
      const boardTasks: BoardTask[] = [
        {
          id: 5,
          title: 'Board job',
          description: '',
          status: 'executing',
          project: 'main',
          assignee: 'alex',
          createdBy: 'sam',
          dependsOn: [],
          createdAt: '',
          updatedAt: '',
        },
      ];
      const reminders: Task[] = [
        {
          id: 1,
          project: 'local',
          description: 'Do a thing',
          owner: 'alex',
          status: 'open',
          createdAt: '',
          updatedAt: '',
        },
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

  describe('open session notes slot (Phase 4)', () => {
    const makeNote = (
      id: number,
      kind: SessionNote['kind'],
      body: string,
    ): SessionNote => ({
      id,
      teamId: 'local',
      ownerBot: 'alex',
      channelId: 'dev:root',
      project: 'local',
      kind,
      body,
      status: 'open',
      createdAt: '',
      updatedAt: '',
    });

    it('renders open notes when present', async () => {
      const openNotes: SessionNote[] = [
        makeNote(1, 'blocker', 'DB migration locked'),
        makeNote(2, 'todo', 'Wire the auth hook'),
      ];
      const { svc } = makeService({ openNotes });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Open notes (this thread):');
      expect(result).toContain('[#1] (blocker) DB migration locked');
      expect(result).toContain('[#2] (todo) Wire the auth hook');
    });

    it('omits the notes section when there are no open notes', async () => {
      const { svc } = makeService({ openNotes: [] });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('Open notes (this thread):');
    });

    it('orders by kind priority: blocker → todo → hypothesis → handoff', async () => {
      const openNotes: SessionNote[] = [
        makeNote(1, 'handoff', 'Hand off to next session'),
        makeNote(2, 'hypothesis', 'Might be a caching issue'),
        makeNote(3, 'todo', 'Wire the auth hook'),
        makeNote(4, 'blocker', 'Missing env var'),
      ];
      const { svc } = makeService({ openNotes });
      const result = await svc.fetchMemory(makeBot(), id);
      const blockerIdx = result.indexOf('(blocker)');
      const todoIdx = result.indexOf('(todo)');
      const hypothesisIdx = result.indexOf('(hypothesis)');
      const handoffIdx = result.indexOf('(handoff)');
      expect(blockerIdx).toBeGreaterThanOrEqual(0);
      expect(blockerIdx).toBeLessThan(todoIdx);
      expect(todoIdx).toBeLessThan(hypothesisIdx);
      expect(hypothesisIdx).toBeLessThan(handoffIdx);
    });

    it('caps at NOTES_CAP (10) and shows overflow note', async () => {
      const openNotes: SessionNote[] = Array.from({ length: 13 }, (_, i) =>
        makeNote(i + 1, 'todo', `Todo item ${i + 1}`),
      );
      const { svc } = makeService({ openNotes });
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('…and 3 more (list_session_notes)');
    });

    it('notes section appears after board tasks and before memory suggestions', async () => {
      const boardTasks: BoardTask[] = [
        {
          id: 1,
          title: 'Build auth',
          description: '',
          status: 'executing',
          project: 'main',
          assignee: 'alex',
          createdBy: 'sam',
          dependsOn: [],
          createdAt: '',
          updatedAt: '',
        },
      ];
      const openNotes: SessionNote[] = [makeNote(1, 'blocker', 'DB locked')];
      const { svc } = makeService({ boardTasks, openNotes });
      const suggestions =
        '• remember: "Dennis wants PRs to target develop" (preference · team)';
      const result = await svc.fetchMemory(makeBot(), id, suggestions);
      const boardIdx = result.indexOf('Active board work:');
      const notesIdx = result.indexOf('Open notes (this thread):');
      const suggestionsIdx = result.indexOf('Memory suggestions');
      expect(boardIdx).toBeGreaterThanOrEqual(0);
      expect(notesIdx).toBeGreaterThanOrEqual(0);
      expect(suggestionsIdx).toBeGreaterThanOrEqual(0);
      expect(boardIdx).toBeLessThan(notesIdx);
      expect(notesIdx).toBeLessThan(suggestionsIdx);
    });

    it('degrades gracefully when sessionNotes.listOpen throws', async () => {
      const semantic = {
        standingContext: vi.fn().mockResolvedValue(''),
      } as unknown as SemanticMemory;
      const tasks = {
        listTasks: vi.fn().mockResolvedValue([]),
        openTasks: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;
      const board = {
        list: vi.fn().mockResolvedValue([]),
      } as unknown as BoardStore;
      const sessionNotes = {
        listOpen: vi.fn().mockRejectedValue(new Error('db error')),
      } as unknown as SessionNoteStore;
      const svc = new FetchService(semantic, tasks, board, sessionNotes);
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).toContain('Standing context:');
      expect(result).not.toContain('Open notes (this thread):');
    });

    it('passes (team, bot.id, surface) to listOpen', async () => {
      const { svc, sessionNotes } = makeService({});
      await svc.fetchMemory(makeBot(), id);
      expect(sessionNotes.listOpen).toHaveBeenCalledWith(
        id.team,
        'alex', // bot.id from makeBot()
        id.surface,
      );
    });
  });

  describe('memory suggestions slot (Phase 2)', () => {
    it('injects suggestions block when memorySuggestions is non-empty', async () => {
      const { svc } = makeService({});
      const suggestions =
        '• remember: "Dennis wants PRs to target develop" (preference · team)';
      const result = await svc.fetchMemory(makeBot(), id, suggestions);
      expect(result).toContain('Memory suggestions from last turn');
      expect(result).toContain('Dennis wants PRs to target develop');
    });

    it('omits the suggestions slot when memorySuggestions is empty string', async () => {
      const { svc } = makeService({});
      const result = await svc.fetchMemory(makeBot(), id, '');
      expect(result).not.toContain('Memory suggestions');
    });

    it('omits the suggestions slot when memorySuggestions is undefined', async () => {
      const { svc } = makeService({});
      const result = await svc.fetchMemory(makeBot(), id, undefined);
      expect(result).not.toContain('Memory suggestions');
    });

    it('suggestions slot appears AFTER standing context and board tasks', async () => {
      const boardTasks: BoardTask[] = [
        {
          id: 1,
          title: 'Build auth',
          description: '',
          status: 'executing',
          project: 'main',
          assignee: 'alex',
          createdBy: 'sam',
          dependsOn: [],
          createdAt: '',
          updatedAt: '',
        },
      ];
      const { svc } = makeService({ boardTasks });
      const suggestions = '• remember: "Backend uses PostgreSQL" (decision)';
      const result = await svc.fetchMemory(makeBot(), id, suggestions);
      const standingIdx = result.indexOf('Standing context:');
      const boardIdx = result.indexOf('Active board work:');
      const suggestionsIdx = result.indexOf('Memory suggestions');
      expect(standingIdx).toBeLessThan(boardIdx);
      expect(boardIdx).toBeLessThan(suggestionsIdx);
    });

    it('fetchContext wrapper does not inject suggestions (no memorySuggestions arg)', async () => {
      const { svc } = makeService({});
      const result = await svc.fetchContext(makeBot(), id);
      expect(result).not.toContain('Memory suggestions');
    });
  });
});
