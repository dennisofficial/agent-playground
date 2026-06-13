import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type FactListResponse, type FactView } from '@workspace/shared';
import { FactViewStore } from '../../harness/memory-admin/fact-view.store';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { FactQueryDto } from './dto/fact-query.dto';

/**
 * Read-only admin view over the semantic-memory facts table.
 * Powers the Memory Viewer UI (`/admin/memory`).
 *
 * Gated by `AdminAuthGuard` (cookie JWT + M2M bearer fallback). God-view:
 * no scope filtering — the admin can inspect facts across all tiers and agents.
 * The embedding vector is never returned.
 */
@Controller('tenants/:teamId/memory/facts')
@UseGuards(AdminAuthGuard)
export class MemoryFactsController {
  constructor(private readonly store: FactViewStore) {}

  /**
   * Filtered, paginated list of facts.
   * Returns `{ items, total, limit, offset }` so the client can:
   * - compute pagination controls from `total`
   * - show the per-tier live/forgotten count from `deletedAt` when `includeDeleted=true`
   */
  @Get()
  list(
    @Param('teamId') teamId: string,
    @Query() query: FactQueryDto,
  ): Promise<FactListResponse> {
    return this.store.list(teamId, query);
  }

  /**
   * Single fact by row id (cross-scope; includes soft-deleted).
   * Returns 404 when the id doesn't exist or doesn't belong to this tenant.
   */
  @Get(':id')
  async get(
    @Param('teamId') teamId: string,
    @Param('id') id: string,
  ): Promise<FactView> {
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      throw new NotFoundException(`No fact with id "${id}".`);
    }
    const fact = await this.store.get(teamId, rowId);
    if (!fact) {
      throw new NotFoundException(
        `No fact with id ${id} for tenant "${teamId}".`,
      );
    }
    return fact;
  }
}
