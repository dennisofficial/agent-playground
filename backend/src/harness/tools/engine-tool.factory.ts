import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Injectable } from '@nestjs/common';
import { captureParentChatTrace } from '@workspace/langfuse';
import { isToolCapability, type ToolCapability } from '../employees/capability';
import type { EmployeeContext } from '../employees/employee-context';
import type { EmployeeDefinition } from '../employees/employee.types';
import { getIdentity } from '../domain/identity';
import { WorkspaceService } from '../workspaces/workspace.service';
import { CreateSessionTool } from './sessions/session.tools';

/**
 * Binds an employee's TOOL-triggered capabilities (e.g. Nora's `deep_research`) into the chat
 * allowlist at GRAPH-BUILD time — the discretionary half of the capability system. Each becomes a
 * StructuredTool that, when called, opens a REAL session via `CreateSessionTool.openSession` (the
 * shared workspace/ownership/ALS-detached path — NOT a parallel worker path), using the engine from
 * the capability's `EngineSpec`. Like `create_session`, the bot is notified when the session reports
 * back.
 *
 * v1 workspace strategy: reuse the caller-supplied `workspaceId`, else the bot's most recent workspace;
 * if it has none, return a friendly nudge to `create_workspace` first (a session must live in one).
 * The research PROMPT is the raw question for now (tuning deferred — see the capability descriptor).
 */
@Injectable()
export class EngineToolFactory {
  constructor(
    private readonly createSession: CreateSessionTool,
    private readonly workspaces: WorkspaceService,
  ) {}

  /** Build the StructuredTools for a bot's tool-capabilities. */
  buildTools(
    bot: EmployeeDefinition,
    ctx: EmployeeContext,
  ): { tools: StructuredToolInterface[] } {
    const caps = bot.capabilities(ctx).filter(isToolCapability);
    return {
      tools: caps.map((cap) => this.toTool(ctx, cap)),
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
        const { question, workspaceId } = (args ?? {}) as {
          question?: string;
          workspaceId?: string;
        };
        const ws = this.resolveWorkspace(identity.selfAgent, workspaceId);
        if ('error' in ws) return ws.error;
        const opening = (question ?? '').trim();
        const { sessionId } = await this.createSession.openSession({
          identity,
          workspaceId: ws.id,
          task: opening.slice(0, 80) || cap.name,
          openingTask: opening || cap.name,
          mode: cap.mode,
          engine,
          parentChatTrace: captureParentChatTrace(),
        });
        return `Opened ${cap.name} session ${sessionId} (${engine}, ${cap.mode}) in ${ws.id}. You're notified when it reports back; it stays open for follow-ups (reply_session).`;
      },
      { name: cap.name, description: cap.description, schema: cap.schema },
    );
  }

  /** Resolve a workspace to run in — the given id, else the bot's latest — or an error to return. */
  private resolveWorkspace(
    ownerBot: string,
    workspaceId?: string,
  ): { id: string } | { error: string } {
    if (workspaceId) {
      const ws = this.workspaces.get(workspaceId);
      return ws
        ? { id: ws.id }
        : {
            error: `No workspace "${workspaceId}" — create one (create_workspace) or check list_workspaces.`,
          };
    }
    const mine = this.workspaces.list({ ownerBot });
    const latest = mine[mine.length - 1];
    return latest
      ? { id: latest.id }
      : {
          error:
            'Open a workspace first (create_workspace) — a research session needs somewhere to run.',
        };
  }
}
