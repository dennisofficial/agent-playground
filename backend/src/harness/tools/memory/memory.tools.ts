import { z } from 'zod';
import { ChannelService } from '../../channel/channel.service';
import { MemoryWriteService } from '../../memory/memory-write.service';
import { SemanticMemory, type StoredFact } from '../../memory/semantic-memory';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The bots' self-managed memory tools. Identity (which bot, which project, who's present) arrives in
 * the tool context (read from the run config set by the conductor), so `remember` resolves the
 * chosen tier to a concrete scope. (Ported from playground/src/memory/tools.ts.)
 */

const fmt = (f: StoredFact): string => `- [#${f.id}] ${f.fact}`;

const rememberSchema = z.object({
  fact: z
    .string()
    .describe(
      'The single bare fact, stated minimally — the claim itself, no elaboration or consequences, e.g. "We standardize on Postgres for all services" (NOT a paragraph about migrations or what it affects).',
    ),
  tier: z
    .enum(['team', 'project', 'bot', 'private'])
    .optional()
    .describe(
      "Who should know it: 'project' (default in a channel — a fact about THIS project: its repo, stack, goals, or a decision), 'team' (roles, who does what, the boss's standing preferences — shared across every project), 'bot' (just you, across all your chats), or 'private' (1:1 with this person — personal or sensitive; the default in a DM).",
    ),
  project: z
    .string()
    .optional()
    .describe(
      "ONLY for tier 'project' in a DM: which project the fact belongs to (a DM isn't bound to one). Must be a project you share with this person — otherwise the fact is kept private to the two of you.",
    ),
});

@HarnessTool()
export class RememberTool implements IHarnessTool<typeof rememberSchema> {
  readonly name = 'remember';
  readonly description =
    'Save a durable fact worth recalling in later conversations — a decision, a preference, a work detail. State it as ONE bare, atomic claim: the fact itself, with no interpretation, consequences, or "what this means" elaboration (those make near-duplicates that never dedup). Pick who should know it.';
  readonly schema = rememberSchema;

  constructor(private readonly writes: MemoryWriteService) {}

  async execute(
    { fact, tier, project }: z.infer<typeof rememberSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    // Write-side leak guard: facts learned in a 1:1 DM default to the pair scope — the read-side
    // guard (recallScopes) only filters recall; a DM confidence stored at project scope would
    // surface in group chat. A project fact from a DM must NAME a shared project (scopeForTier
    // validates and falls back to pair).
    const t = tier ?? (ctx.identity.isChannel ? 'project' : 'private');
    const res = await this.writes.rememberDeduped({
      fact,
      tier: t,
      id: ctx.identity,
      project,
    });
    return `${res.action === 'updated' ? 'Updated what I knew' : 'Remembered'} (${t}).`;
  }
}

const recallSchema = z.object({
  query: z
    .string()
    .describe('What you want to remember about, in natural language.'),
});

@HarnessTool()
export class RecallTool implements IHarnessTool<typeof recallSchema> {
  readonly name = 'recall_facts';
  readonly description =
    "Semantic facts you've explicitly saved — use this to retrieve durable facts about the project, team, or people. Each result carries its #id — pass that id to update_memory or forget to change a specific fact.";
  readonly schema = recallSchema;

  constructor(private readonly semantic: SemanticMemory) {}

  async execute(
    { query }: z.infer<typeof recallSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const facts = await this.semantic.recall(query, ctx.identity);
    if (facts.length === 0) return 'Nothing saved that matches.';
    return `What I know that's relevant:\n${facts.map(fmt).join('\n')}`;
  }
}

const updateSchema = z.object({
  id: z
    .number()
    .describe('The #id of the fact to correct (the [#N] from recall).'),
  newFact: z
    .string()
    .describe(
      'The corrected fact, stated minimally — one bare atomic claim, no elaboration or consequences.',
    ),
});

@HarnessTool()
export class UpdateMemoryTool implements IHarnessTool<typeof updateSchema> {
  readonly name = 'update_memory';
  readonly description =
    'Correct an existing fact by its #id (the [#N] shown by recall) when something changes. Recall first to get the id — there is no fuzzy matching, and an unknown id is a no-op.';
  readonly schema = updateSchema;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly writes: MemoryWriteService,
  ) {}

  async execute(
    { id: factId, newFact }: z.infer<typeof updateSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const updated = await this.writes.withLock(() =>
      this.semantic.updateFactById(factId, newFact, ctx.identity),
    );
    return updated
      ? `Updated #${factId}.`
      : `No live fact #${factId} to update.`;
  }
}

const forgetSchema = z.object({
  id: z
    .number()
    .describe('The #id of the fact to forget (the [#N] from recall).'),
});

@HarnessTool()
export class ForgetTool implements IHarnessTool<typeof forgetSchema> {
  readonly name = 'forget';
  readonly description =
    'Forget a saved fact by its #id (the [#N] shown by recall; soft-deleted, not destroyed). Recall first to get the id — there is no fuzzy matching, and an unknown id is a no-op. Use when something is no longer true.';
  readonly schema = forgetSchema;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly writes: MemoryWriteService,
  ) {}

  async execute(
    { id: factId }: z.infer<typeof forgetSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const gone = await this.writes.withLock(() =>
      this.semantic.forgetFactById(factId, ctx.identity),
    );
    return gone ? `Forgot #${factId}.` : `No live fact #${factId} to forget.`;
  }
}

const searchConversationHistorySchema = z.object({
  query: z
    .string()
    .describe('Keywords or a phrase to search for in past messages.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max results to return (default 20).'),
});

@HarnessTool()
export class SearchConversationHistoryTool
  implements IHarnessTool<typeof searchConversationHistorySchema>
{
  readonly name = 'search_conversation_history';
  readonly description =
    'Search through past channel messages for exact words, decisions, or context — returns who said what and when.';
  readonly schema = searchConversationHistorySchema;

  constructor(private readonly channelService: ChannelService) {}

  async execute(
    { query, limit }: z.infer<typeof searchConversationHistorySchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const hits = await this.channelService.search({
      teamId: ctx.identity.team,
      surfaceIds: [ctx.identity.surface],
      query,
      limit,
    });
    if (hits.length === 0) return 'No messages found matching that query.';
    return hits
      .map((h) => {
        const when = new Date(h.ts).toISOString();
        return `[${when}] ${h.author}: ${h.snippet}`;
      })
      .join('\n');
  }
}
