import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { captureParentChatTrace } from '@workspace/langfuse';
import { isToolCapability, type ToolCapability } from '../employees/capability';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { getIdentity } from '../domain/identity';
import { WorktreeService } from '../worktrees/worktree.service';
import { CreateSessionTool } from './sessions/session.tools';

/**
 * Binds an employee's TOOL-triggered capabilities (e.g. Nora's `deep_research`) into the chat
 * allowlist at GRAPH-BUILD time — the discretionary half of the capability system. Each becomes a
 * StructuredTool that, when called, opens a REAL session via `CreateSessionTool.openSession` (the
 * shared worktree/ownership/ALS-detached path — NOT a parallel worker path), using the engine from
 * the capability's `EngineSpec`. Like `create_session`, these tools END the turn (terminal).
 *
 * v1 worktree strategy: reuse the caller-supplied `worktreeId`, else the bot's most recent worktree;
 * if it has none, return a friendly nudge to `create_worktree` first (a session must live in one).
 * The research PROMPT is the raw question for now (tuning deferred — see the capability descriptor).
 */
@Injectable()
export class EngineToolFactory {
  constructor(
    private readonly createSession: CreateSessionTool,
    private readonly worktrees: WorktreeService,
  ) {}

  /** Build the StructuredTools + their (terminal) names for a bot's tool-capabilities. */
  buildTools(
    bot: EmployeeDefinition,
    ctx: EmployeeContext,
  ): { tools: StructuredToolInterface[]; terminalNames: string[] } {
    const caps = bot.capabilities(ctx).filter(isToolCapability);
    return {
      tools: caps.map((cap) => this.toTool(ctx, cap)),
      terminalNames: caps.map((cap) => cap.name),
    };
  }

  private toTool(
    ctx: EmployeeContext,
    cap: ToolCapability,
  ): StructuredToolInterface {
    const engine = cap.spec(ctx).engine;
    return tool(
      async (
        args: unknown,
        config?: { configurable?: Record<string, unknown> },
      ): Promise<string> => {
        const identity = getIdentity(config);
        const { question, worktreeId } = (args ?? {}) as {
          question?: string;
          worktreeId?: string;
        };
        const wt = this.resolveWorktree(identity.selfAgent, worktreeId);
        if ('error' in wt) return wt.error;
        const opening = (question ?? '').trim();
        const { sessionId } = await this.createSession.openSession({
          identity,
          worktreeId: wt.id,
          task: opening.slice(0, 80) || cap.name,
          openingTask: opening || cap.name,
          mode: cap.mode,
          engine,
          parentChatTrace: captureParentChatTrace(),
        });
        return `Opened ${cap.name} session ${sessionId} (${engine}, ${cap.mode}) in ${wt.id}. You're notified when it reports back; it stays open for follow-ups (reply_session).`;
      },
      { name: cap.name, description: cap.description, schema: cap.schema },
    );
  }

  /** Resolve a worktree to run in — the given id, else the bot's latest — or an error to return. */
  private resolveWorktree(
    ownerBot: string,
    worktreeId?: string,
  ): { id: string } | { error: string } {
    if (worktreeId) {
      const wt = this.worktrees.get(worktreeId);
      return wt
        ? { id: wt.id }
        : {
            error: `No worktree "${worktreeId}" — create one (create_worktree) or check list_worktrees.`,
          };
    }
    const mine = this.worktrees.list({ ownerBot });
    const latest = mine[mine.length - 1];
    return latest
      ? { id: latest.id }
      : {
          error:
            'Open a worktree first (create_worktree) — a research session needs somewhere to run.',
        };
  }
}
