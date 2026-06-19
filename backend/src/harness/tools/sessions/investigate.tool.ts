import { Inject } from '@nestjs/common';
import { z } from 'zod';
import type { Identity } from '../../domain/identity';
import {
  DEFAULT_INVESTIGATE_PROMPT,
  INVESTIGATE_INTENTS,
} from '../../engines/engine.prompts';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { ProjectStore } from '../../projects/project-store';
import type { ProjectRecord } from '../../projects/project.types';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { ReferenceLibraryService } from '../../workspaces/reference-library.service';
import { WorkspaceReader } from '../../workspaces/workspace-reader';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';
import { CreateSessionTool } from './session.tools';

const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?$/;

const investigateSchema = z.object({
  question: z
    .string()
    .describe(
      'The code-grounded question to answer — be specific (e.g. "how does the conductor gate decide to respond?", "where is the board-claim race handled?", "does X already exist?").',
    ),
  intent: z
    .enum(INVESTIGATE_INTENTS)
    .optional()
    .describe(
      "Why you're investigating — sharpens what the worker focuses on. 'trace' = walk a known flow/path; 'debug' = chase unexpected behavior or check whether a premise is even true; 'review' = judge a design's trade-offs/risks. Omit if none fits.",
    ),
  workspaceId: z
    .string()
    .optional()
    .describe(
      'Which workspace to read in. Omit to use your latest workspace (or to auto-open a fresh one if you have none) — you rarely need to set this.',
    ),
  board_task_id: z
    .number()
    .int()
    .optional()
    .describe(
      "The board task this read grounds (#N) — set it when you're grounding a feature's section breakdown so the decomposition traces to a real code read (the dispatch guard looks for an investigate tied to the task).",
    ),
  references: z
    .array(z.string())
    .optional()
    .describe(
      'Other projects to also read read-only for grounding — catalog ids/names (e.g. "cubix-infra") or GitHub URLs. Each is cloned read-only and the worker can read it ALONGSIDE the main repo (e.g. "how does cubix-infra do SSE?"). Unresolved names come back with a Remedy.',
    ),
});

/**
 * The fact-grounding tool — every employee has it. It's how an employee BACKS a fact or decision with
 * the real codebase instead of answering from memory: it opens a session in the `investigate` mode
 * (read-only at the engine seam, like plan, so it can never modify anything and needs no approval; but
 * WITHOUT the engine's native plan ceremony — the worker reads/greps and answers directly in one turn
 * instead of producing a plan artifact).
 *
 * It reuses `CreateSessionTool.openSession` (the shared workspace/ownership/ALS-detached path) on the
 * employee's INVESTIGATE engine recipe (execute's engine on a top-tier reasoning model — grounding
 * facts is worth the better model). The session stays open for read-only follow-ups (reply_session).
 * Like `create_session`, the answer relays back when the turn reports.
 */
@HarnessTool()
export class InvestigateTool implements IHarnessTool<typeof investigateSchema> {
  readonly name = 'investigate';
  readonly description =
    "Ground your answer in the ACTUAL codebase before you commit to it — spins up a read-only worker that reads/greps the real repo and reports what's actually true. Reach for it ANY time your reply, decision, or recommendation rests on a checkable fact about the code (how does X work, where is Y, does Z already exist, is this premise even true) and an open session or your memory doesn't already hold it: back it with the code instead of answering from memory or assumption. It never modifies anything and needs no approval. Put any brief first-person heads-up in THIS message's text; you're notified when it reports back, and it stays open for read-only follow-ups (reply_session).";
  readonly schema = investigateSchema;

  constructor(
    private readonly createSession: CreateSessionTool,
    private readonly workspaces: WorkspaceReader,
    private readonly refs: ReferenceLibraryService,
    private readonly employees: EmployeeRegistry,
    private readonly projects: ProjectStore,
    @Inject(SESSION_REGISTRY)
    private readonly sessions: SessionRegistry,
  ) {}

  async execute(
    { question, intent, workspaceId, board_task_id, references }: z.infer<
      typeof investigateSchema
    >,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const bot =
      this.employees.byId(id.selfAgent) ?? this.employees.fallbackOwner();
    // Investigate runs on the INVESTIGATE recipe (the session-runner resolves the mode to it); pin the
    // create-time engine to match so the per-turn spec's engine never disagrees. (Same engine as
    // execute — investigate is a model-only override — so this is just sourcing it from one builder.)
    const engine = bot.investigateEngine(this.employees.context()).engine;

    const ws = await this.resolveWorkspace(id, workspaceId);
    if ('error' in ws) return ws.error;

    // Materialize any reference repos in the shared host library — they're mounted read-only into this
    // session's sandbox at /refs/<slug>, so the path we hand the worker is one it can actually read.
    const refs = await this.resolveReferences(id.team, references ?? []);

    const opening = question.trim();
    // The shared investigate template adds the read-only/cite-file:line framing, the optional
    // intent emphasis, and the REQUIRED Confidence/Couldn't-verify trailer (see engine.prompts.ts).
    const refBlock = refs.resolved.length
      ? `\n\nReference repos you may ALSO read (read-only, paths outside the main workspace):\n${refs.resolved
          .map((r) => `- ${r.label} at ${r.path}`)
          .join('\n')}`
      : '';
    const openingTask =
      DEFAULT_INVESTIGATE_PROMPT({ question: opening, intent }) + refBlock;
    const { sessionId } = await this.createSession.openSession({
      identity: id,
      workspaceId: ws.id,
      task: opening.slice(0, 80) || 'investigate',
      openingTask,
      mode: 'investigate',
      engine,
      boardTaskId: board_task_id,
      parentChatTrace: ctx.parentChatTrace,
    });
    // Record the attached references on the session (durable read set — the v2 container-mount seam).
    if (refs.resolved.length)
      await this.sessions
        .update(sessionId, {
          referencedProjects: refs.resolved.map((r) => ({
            ...(r.projectId ? { projectId: r.projectId } : {}),
            gitUrl: r.gitUrl,
            path: r.path,
            mode: 'read' as const,
          })),
        })
        .catch(() => undefined);

    const refNote = refs.resolved.length
      ? ` Reading also: ${refs.resolved.map((r) => r.label).join(', ')}.`
      : '';
    // Distinct remedies per failure mode — a clone that couldn't materialize is NOT the same as a name
    // that isn't registered, and neither means "needs a token" by default. Keeping them separate stops
    // the model improvising a wrong diagnosis (the "not in my references / needs a token" story).
    const remedies: string[] = [];
    if (refs.catalogUnavailable)
      remedies.push("couldn't read the project catalog just now — retry in a moment");
    if (refs.notRegistered.length)
      remedies.push(
        `${refs.notRegistered.join(', ')} ${refs.notRegistered.length === 1 ? "isn't" : "aren't"} in the catalog — onboard_project them (or check the name)`,
      );
    if (refs.cloneFailed.length)
      remedies.push(
        `couldn't clone ${refs.cloneFailed.join(', ')} read-only — retry; if it persists the token may lack access (onboard_project can collect one)`,
      );
    const missingNote = remedies.length ? `\nRemedy: ${remedies.join('; ')}.` : '';
    return `Investigating in ${ws.id}${ws.created ? ' (opened a fresh workspace)' : ''}: ${sessionId} (${engine}, read-only).${refNote} You're notified when it reports back; close_session it once you have your answer.${missingNote}`;
  }

  /**
   * Resolve reference names/URLs to read-only clones in the shared host reference library (mounted into
   * this session's sandbox at `/refs/<slug>`). A catalog name (id or display name) resolves to its
   * project; a GitHub URL is a one-off. Failures are bucketed by KIND rather than failing the whole
   * investigation, so the caller can give a precise Remedy instead of one vague "couldn't resolve".
   */
  private async resolveReferences(
    team: string,
    names: string[],
  ): Promise<{
    resolved: {
      label: string;
      path: string;
      projectId?: string;
      gitUrl: string;
    }[];
    /** Names that aren't a registered project (and aren't a GitHub URL) → onboard_project. */
    notRegistered: string[];
    /** Targets whose clone/fetch failed → retry / token. */
    cloneFailed: string[];
    /** The project catalog couldn't be read this turn → retry (NOT "not registered"). */
    catalogUnavailable: boolean;
  }> {
    const resolved: {
      label: string;
      path: string;
      projectId?: string;
      gitUrl: string;
    }[] = [];
    const notRegistered: string[] = [];
    const cloneFailed: string[] = [];
    let catalogUnavailable = false;
    if (names.length === 0)
      return { resolved, notRegistered, cloneFailed, catalogUnavailable };

    // Resolve catalog NAMES (id or display name) to a projectId host-side; URLs go straight through.
    // A catalog LOAD failure is distinct from a genuine miss — a DB hiccup must not read as "not registered".
    let catalog: ProjectRecord[] | undefined;
    try {
      catalog = await this.projects.list(team);
    } catch {
      catalog = undefined;
    }

    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      let target: { projectId?: string; gitUrl?: string };
      let label: string;
      let projectId: string | undefined;
      if (GITHUB_URL.test(name)) {
        target = { gitUrl: name };
        label = name;
      } else {
        if (!catalog) {
          catalogUnavailable = true;
          continue;
        }
        const rec = catalog.find(
          (p) =>
            p.projectId.toLowerCase() === name.toLowerCase() ||
            p.displayName.toLowerCase() === name.toLowerCase(),
        );
        if (!rec) {
          notRegistered.push(name);
          continue;
        }
        target = { projectId: rec.projectId };
        label = rec.projectId;
        projectId = rec.projectId;
      }
      const r = await this.refs.ensureReference(team, target);
      if (r.ok) {
        resolved.push({ label, path: r.mountPath, projectId, gitUrl: r.gitUrl });
      } else if (r.reason === 'not-registered') {
        notRegistered.push(label);
      } else if (r.reason === 'catalog-unavailable') {
        catalogUnavailable = true;
      } else {
        cloneFailed.push(label);
      }
    }
    return { resolved, notRegistered, cloneFailed, catalogUnavailable };
  }

  /**
   * Resolve a workspace to read in: the given id, else the bot's latest, else auto-open a fresh one so
   * investigate "just works" (a read-only session still needs a checkout to read). Read-only, so it's
   * fine to reuse a workspace that has an execute session's in-progress changes — you're reading the
   * current state of the work.
   */
  private async resolveWorkspace(
    id: Identity,
    workspaceId?: string,
  ): Promise<{ id: string; created?: boolean } | { error: string }> {
    if (workspaceId) {
      const ws = this.workspaces.get(workspaceId);
      return ws
        ? { id: ws.id }
        : {
            error: `No workspace "${workspaceId}" — check list_workspaces, or omit it to use your latest.`,
          };
    }
    const mine = this.workspaces.list({ ownerBot: id.selfAgent });
    const latest = mine[mine.length - 1];
    if (latest) return { id: latest.id };
    // WORKSTATION model: a workspace is a per-branch SANDBOX realized by create_workspace (the daemon
    // checks the branch out at boot) — there's no port-side cut-a-branch path anymore. With no workspace
    // to read in, point the bot at create_workspace rather than silently failing.
    return {
      error:
        'You have no workstation to investigate in yet. Create one first with create_workspace (e.g. kind=base to read the integration branch), then investigate.',
    };
  }
}
