// Shared DTOs / wire models (request+response shapes for the admin API).
//
// The request DTOs are class-validator / class-transformer decorated classes, reused
// on BOTH sides: NestJS validates them server-side, and the web drives React Hook Form
// via `classValidatorResolver(SomeDto)`. Those decorators (`@Type` in particular) call
// `Reflect.getMetadata` the moment the class is defined, so `reflect-metadata` must be
// loaded first — including in the browser, which has no built-in metadata reflection.
// This side-effect import is the single place that guarantees it, for every consumer of
// this barrel (and of the root `@workspace/shared` barrel that re-exports it).
import 'reflect-metadata';

export * from './auth.dto';
export * from './credentials.dto';
export * from './org.dto';
export * from './repo.dto';
