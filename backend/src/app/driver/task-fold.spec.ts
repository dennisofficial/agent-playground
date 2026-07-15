import { describe, expect, it } from 'vitest';
import { foldTaskEvent } from './task-fold';

/**
 * Unit tests for the PURE single-event task fold — the server-side successor to the web's old batch
 * `foldTasks` (ported from `thread-todos.ts` when the transcript-fold hack was removed). No I/O; the
 * store's read-modify-write is covered by the int test.
 */

describe('foldTaskEvent', () => {
  it('registers a task from TaskCreate, parsing the id out of the SDK’s STRING result', () => {
    // The real engine result shape — a plain string, not a structured object.
    const tasks = foldTaskEvent(
      [],
      'taskcreate',
      { subject: 'Write the migration' },
      'Task #6 created successfully: Write the migration',
    );
    expect(tasks).toEqual([
      { id: '6', subject: 'Write the migration', status: 'pending' },
    ]);
  });

  it('registers a task from TaskCreate with a structured { task: { id } } result (fallback shape)', () => {
    const tasks = foldTaskEvent(
      [],
      'taskcreate',
      { subject: 'Write the migration' },
      { task: { id: 't1' } },
    );
    expect(tasks).toEqual([
      { id: 't1', subject: 'Write the migration', status: 'pending' },
    ]);
  });

  it('captures description + activeForm on create and keeps them across updates', () => {
    const created = foldTaskEvent(
      [],
      'taskcreate',
      {
        subject: 'Resolve chain',
        description: 'Config → detect → fallback.',
        activeForm: 'Resolving the chain',
      },
      'Task #2 created successfully: Resolve chain',
    );
    expect(created[0]).toEqual({
      id: '2',
      subject: 'Resolve chain',
      status: 'pending',
      description: 'Config → detect → fallback.',
      activeForm: 'Resolving the chain',
    });

    // A status-only update keeps the display fields; an update carrying new ones overwrites.
    const started = foldTaskEvent(
      created,
      'taskupdate',
      { taskId: '2', status: 'in_progress' },
      {},
    );
    expect(started[0]).toMatchObject({
      status: 'in_progress',
      description: 'Config → detect → fallback.',
      activeForm: 'Resolving the chain',
    });
    const edited = foldTaskEvent(
      started,
      'taskupdate',
      { taskId: '2', description: 'New detail.' },
      {},
    );
    expect(edited[0]).toMatchObject({
      description: 'New detail.',
      activeForm: 'Resolving the chain',
    });
  });

  it('falls back to input.description, then the id itself, when subject is missing', () => {
    const byDescription = foldTaskEvent(
      [],
      'taskcreate',
      { description: 'Run tests' },
      { task: { id: 't1' } },
    );
    expect(byDescription[0].subject).toBe('Run tests');

    const byId = foldTaskEvent([], 'taskcreate', {}, { task: { id: 't1' } });
    expect(byId[0].subject).toBe('t1');
  });

  it('is a no-op if the create result has not landed / carries no recognizable id', () => {
    expect(foldTaskEvent([], 'taskcreate', { subject: 'x' }, {})).toEqual([]);
    expect(foldTaskEvent([], 'taskcreate', { subject: 'x' }, null)).toEqual([]);
    expect(
      foldTaskEvent([], 'taskcreate', { subject: 'x' }, 'Something went wrong'),
    ).toEqual([]);
    expect(
      foldTaskEvent([], 'taskcreate', { subject: 'x' }, 'Task creation failed'),
    ).toEqual([]);
  });

  it('transitions status via TaskUpdate, keyed by input.taskId', () => {
    const seeded = [
      { id: 't1', subject: 'Write the migration', status: 'pending' as const },
    ];
    const tasks = foldTaskEvent(
      seeded,
      'taskupdate',
      { taskId: 't1', status: 'in_progress' },
      {},
    );
    expect(tasks).toEqual([
      { id: 't1', subject: 'Write the migration', status: 'in_progress' },
    ]);
  });

  it('REMOVES a task on the SDK deleted status (deleted means gone, not struck-through)', () => {
    const seeded = [
      { id: 't1', subject: 'x', status: 'pending' as const },
      { id: 't2', subject: 'y', status: 'completed' as const },
    ];
    const tasks = foldTaskEvent(
      seeded,
      'taskupdate',
      { taskId: 't1', status: 'deleted' },
      {},
    );
    expect(tasks).toEqual([{ id: 't2', subject: 'y', status: 'completed' }]);
    // Deleting an id the fold never saw is a no-op — no defensive entry for a tombstone.
    expect(
      foldTaskEvent(
        tasks,
        'taskupdate',
        { taskId: 't9', status: 'deleted' },
        {},
      ),
    ).toEqual(tasks);
  });

  it('updates the subject when TaskUpdate carries one, else keeps the existing subject', () => {
    const seeded = [
      { id: 't1', subject: 'old subject', status: 'pending' as const },
    ];
    const renamed = foldTaskEvent(
      seeded,
      'taskupdate',
      { taskId: 't1', subject: 'new subject' },
      {},
    );
    expect(renamed[0].subject).toBe('new subject');

    const untouched = foldTaskEvent(
      seeded,
      'taskupdate',
      { taskId: 't1', status: 'completed' },
      {},
    );
    expect(untouched[0].subject).toBe('old subject');
  });

  it('creates a defensive entry for a TaskUpdate whose id was never created', () => {
    const tasks = foldTaskEvent(
      [],
      'taskupdate',
      { taskId: 't9', status: 'completed' },
      {},
    );
    expect(tasks).toEqual([{ id: 't9', subject: 't9', status: 'completed' }]);
  });

  it('is a no-op for TaskUpdate with no taskId', () => {
    const seeded = [{ id: 't1', subject: 'x', status: 'pending' as const }];
    expect(foldTaskEvent(seeded, 'taskupdate', {}, {})).toBe(seeded);
  });

  it('ignores TaskList/TaskGet and any unrecognized tool name', () => {
    const seeded = [{ id: 't1', subject: 'x', status: 'pending' as const }];
    expect(foldTaskEvent(seeded, 'tasklist', {}, {})).toBe(seeded);
    expect(foldTaskEvent(seeded, 'taskget', {}, {})).toBe(seeded);
    expect(foldTaskEvent(seeded, 'bash', {}, {})).toBe(seeded);
  });

  it('folds dependency edges: addBlockedBy accumulates, removeBlockedBy clears, addBlocks is the inverse', () => {
    let tasks = foldTaskEvent(
      [],
      'taskcreate',
      { subject: 'a' },
      'Task #1 created successfully: a',
    );
    tasks = foldTaskEvent(
      tasks,
      'taskcreate',
      { subject: 'b' },
      'Task #2 created successfully: b',
    );
    tasks = foldTaskEvent(
      tasks,
      'taskcreate',
      { subject: 'c' },
      'Task #3 created successfully: c',
    );

    // #2 waits on #1; then #1 declares it ALSO blocks #3 (the inverse edge folds onto #3.blockedBy).
    tasks = foldTaskEvent(
      tasks,
      'taskupdate',
      { taskId: '2', addBlockedBy: ['1'] },
      {},
    );
    tasks = foldTaskEvent(
      tasks,
      'taskupdate',
      { taskId: '1', addBlocks: ['3'] },
      {},
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(byId.get('2')?.blockedBy).toEqual(['1']);
    expect(byId.get('3')?.blockedBy).toEqual(['1']);
    // A status-only update keeps the edges; removeBlockedBy clears (dropping the key when empty).
    tasks = foldTaskEvent(
      tasks,
      'taskupdate',
      { taskId: '2', status: 'in_progress' },
      {},
    );
    expect(tasks.find((t) => t.id === '2')?.blockedBy).toEqual(['1']);
    tasks = foldTaskEvent(
      tasks,
      'taskupdate',
      { taskId: '2', removeBlockedBy: ['1'] },
      {},
    );
    expect(tasks.find((t) => t.id === '2')?.blockedBy).toBeUndefined();
  });

  it('preserves insertion order across multiple creates', () => {
    let tasks = foldTaskEvent(
      [],
      'taskcreate',
      { subject: 'first' },
      { task: { id: 't1' } },
    );
    tasks = foldTaskEvent(
      tasks,
      'taskcreate',
      { subject: 'second' },
      { task: { id: 't2' } },
    );
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
