// @workspace/shared — code shared between the backend and the admin web.
// Single barrel for now; real content (Employee, ConductorEvent, job-update
// payloads, identity types, zod schemas) lands during the harness-migration pass.
//
// The `./dto` classes carry class-validator / class-transformer decorators and are
// ISOMORPHIC: NestJS validates them server-side, and the web reuses the same class
// with React Hook Form's `classValidatorResolver`. `./dto` loads `reflect-metadata`
// as its first side effect so the decorators evaluate in the browser too.
export * from './enums';
export * from './types';
export * from './dto';
export * from './agent-credentials';
