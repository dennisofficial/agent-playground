import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ConventionProfileEntity, RepoEntity } from '../persistence/entities';
import { ConventionProfileResolver } from './convention-profile.resolver';

/**
 * The house-style conventions layer — reusable per-org {@link ConventionProfileEntity} profiles + the
 * opt-in `repos.convention_profile_slug` pointer, resolved per turn by {@link ConventionProfileResolver}
 * into `ctx.settings.repoConventions` / `RunEngineArgs.repoConventions`. `@Global` (like `McpModule` /
 * `OnboardingModule`) so the brain, driver, and autofix turn-assembly paths inject the resolver with zero
 * per-module import churn.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ConventionProfileEntity, RepoEntity], DB_CONNECTION)],
  providers: [ConventionProfileResolver],
  exports: [ConventionProfileResolver],
})
export class ConventionsModule {}
