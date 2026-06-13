import {
  ENTITIES,
  TeamSetting as TeamSettingEntity,
  TeamTaskNote as TeamTaskNoteEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { TeamSettingsStore } from './team-settings-store';
import { TicketNoteStore } from './ticket-note-store';

function makeDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    synchronize: false,
  });
}

describe('TicketNoteStore + TeamSettingsStore (live Postgres)', () => {
  let ds: DataSource;
  let notes: TicketNoteStore;
  let settings: TeamSettingsStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    notes = new TicketNoteStore(ds.getRepository(TeamTaskNoteEntity));
    settings = new TeamSettingsStore(ds.getRepository(TeamSettingEntity));
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE team_task_notes RESTART IDENTITY');
    await ds.query('TRUNCATE team_settings');
  });

  it('notes append and page newest-first with a stable total', async () => {
    for (let i = 1; i <= 12; i++) await notes.add('T1', 7, 'nora', `note ${i}`);
    const p1 = await notes.listForTask('T1', 7, { page: 1, pageSize: 10 });
    expect(p1.total).toBe(12);
    expect(p1.notes).toHaveLength(10);
    expect(p1.notes[0].body).toBe('note 12'); // newest first
    const p2 = await notes.listForTask('T1', 7, { page: 2, pageSize: 10 });
    expect(p2.notes.map((n) => n.body)).toEqual(['note 2', 'note 1']);
  });

  it('a note is read back by id, scoped to its task and team', async () => {
    const n = await notes.add('T1', 7, 'nora', '# A long research MD\n…');
    expect((await notes.get('T1', 7, n.id))?.body).toContain('research MD');
    expect(await notes.get('T1', 8, n.id)).toBeUndefined();
    expect(await notes.get('T2', 7, n.id)).toBeUndefined();
  });

  it('the standup flag flips and a missing row reads as closed', async () => {
    expect(await settings.isStandupOpen('T1')).toBe(false); // no row yet
    await settings.setStandupOpen('T1', true);
    expect(await settings.isStandupOpen('T1')).toBe(true);
    expect(await settings.isStandupOpen('T2')).toBe(false); // team isolation
    await settings.setStandupOpen('T1', false);
    expect(await settings.isStandupOpen('T1')).toBe(false);
  });
});
