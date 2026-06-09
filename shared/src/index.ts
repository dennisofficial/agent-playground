// @workspace/shared — code shared between the backend and the admin web.
// Single barrel for now; real content (Employee, ConductorEvent, job-update
// payloads, identity types, zod schemas) lands during the harness-migration pass.
export * from './types';
export * from './dto';
