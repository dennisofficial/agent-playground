import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Query params for `GET /tenants/:teamId/memory/facts`.
 * All params are optional — omitting them means "no filter / use the default".
 */
export class FactQueryDto {
  /** Restrict to one sharing tier. */
  @IsOptional()
  @IsEnum(['team', 'project', 'bot', 'private'], {
    message: 'tier must be one of: team, project, bot, private',
  })
  tier?: 'team' | 'project' | 'bot' | 'private';

  /** Exact project id — scopes results to `project:{projectId}`. */
  @IsOptional()
  @IsString()
  projectId?: string;

  /** Agent id — matches facts whose scope is `bot:{botId}` or `pair:{botId}:{human}`. */
  @IsOptional()
  @IsString()
  botId?: string;

  /** Human who stated the fact (`asserted_by` column). */
  @IsOptional()
  @IsString()
  assertedBy?: string;

  /** Server-side substring filter (case-insensitive). Primary search is client-side. */
  @IsOptional()
  @IsString()
  q?: string;

  /**
   * Include soft-deleted ("forgotten") facts. Default: false.
   * Pass `true` to load all facts and do the live/forgotten split client-side.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeDeleted?: boolean;

  /**
   * Include facts with `team_id IS NULL` (global/promoted, shared across workspaces).
   * Default: true — mirrors agent recall semantics.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeGlobal?: boolean;

  /** Max items per page. Default: 50. Capped at 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Zero-based page offset. Default: 0. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** Sort field, always descending. Default: 'updated'. */
  @IsOptional()
  @IsEnum(['updated', 'created'], {
    message: 'sort must be one of: updated, created',
  })
  sort?: 'updated' | 'created';
}
