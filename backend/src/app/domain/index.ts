/**
 * Atlas v2 core domain types — clean, documented, IN-MEMORY shapes (the triage/work currency), kept
 * deliberately separate from the `app` persistence entities under `../persistence/entities`. The
 * brain and the deterministic driver speak these; the persistence layer maps them to/from rows.
 *
 * Zero v1 imports: nothing here reaches into `@harness/**` or the v1 `slack-app` surface.
 */
export * from './seed-row';
export * from './message';
export * from './notification-source';
export * from './job';
export * from './decision-record';
export * from './session-ref';
