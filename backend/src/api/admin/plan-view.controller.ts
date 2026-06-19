import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { type BoardTaskView, type PlanView } from '@workspace/shared';
import { PlanViewStore } from '../../harness/plan-view/plan-view.store';

/**
 * Read-only admin view over the team board, plans, and feature pipelines.
 * Powers the web Plan Viewer (`/plans/:teamId/:taskId`) and board dashboard.
 *
 * Gated by the global AdminAuthGuard (APP_GUARD — cookie JWT + M2M bearer fallback). God-view:
 * no scope filtering beyond the tenant path param.
 */
@Controller('tenants/:teamId')
export class PlanViewController {
  constructor(private readonly store: PlanViewStore) {}

  /**
   * The full plan-viewer payload for one task: task + its single current plan + (for feature work)
   * the pipeline run whose sections each carry their archived plan. 404 when the task doesn't
   * exist for this tenant.
   */
  @Get('plans/:taskId')
  async getPlan(
    @Param('teamId') teamId: string,
    @Param('taskId') taskId: string,
  ): Promise<PlanView> {
    const id = Number(taskId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new NotFoundException(`No task with id "${taskId}".`);
    }
    const plan = await this.store.getPlan(teamId, id);
    if (!plan) {
      throw new NotFoundException(
        `No task with id ${taskId} for tenant "${teamId}".`,
      );
    }
    return plan;
  }

  /** All board tasks for the tenant (newest-touched first). */
  @Get('board')
  getBoard(@Param('teamId') teamId: string): Promise<BoardTaskView[]> {
    return this.store.getBoard(teamId);
  }
}
