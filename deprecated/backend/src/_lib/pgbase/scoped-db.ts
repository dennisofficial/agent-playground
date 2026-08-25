import { ScopedPrismaToken } from '@dltech/pgbase/nest';
import type { PrismaClient } from '../../generated/prisma/client';
import { atlasPolicies } from './policies';

/**
 * Prisma with the caller's RLS predicate already applied.
 *
 * A class rather than a symbol so it carries the client and the policy registry as generics:
 * `scopedDb.job` is typed from the schema, models registered as NO_CLIENT_ACCESS do not exist on
 * it, and no `@Inject` is needed.
 *
 * There is no bypass. Work with no caller to scope to — queue workers, the reaper, seeds — injects
 * `PrismaService` instead; calling a scoped delegate outside a request throws rather than reading
 * something arbitrary.
 */
export class ScopedDb extends ScopedPrismaToken<PrismaClient, typeof atlasPolicies>() {}
