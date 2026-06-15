import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  compactPriorToolResults,
  dropLeadingOrphanToolResults,
  filterToolDispatchMessages,
  pairSafeBoundary,
} from './message-helpers';

/**
 * Unit tests for the read-time tool-result compaction transform.
 *
 * The contract:
 *  - ToolMessages whose tool_call_id belongs to the LAST AI message stay full (current-turn).
 *  - ToolMessages from ALL other AI messages get replaced with short evidence records.
 *  - The checkpoint is never mutated — the array is only allocated when something changed.
 *  - Args are capped at 100 chars; results at 200 chars.
 *  - tool_call_id and name are preserved on the compacted ToolMessage.
 */
describe('compactPriorToolResults', () => {
  it('returns the same array reference when there are no ToolMessages', () => {
    const history = [new HumanMessage('hi'), new AIMessage('hello')];
    expect(compactPriorToolResults(history)).toBe(history);
  });

  it('returns the same array when the only ToolMessages belong to the last AI message', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        { name: 'recall', args: { query: 'foo' }, id: 'c1', type: 'tool_call' },
      ],
    });
    const tool = new ToolMessage({
      tool_call_id: 'c1',
      name: 'recall',
      content:
        'A very long result that must NOT be compacted — it is the current turn',
    });
    const history = [new HumanMessage('hi'), ai, tool];
    expect(compactPriorToolResults(history)).toBe(history);
    // Content unchanged
    expect((compactPriorToolResults(history)[2] as ToolMessage).content).toBe(
      'A very long result that must NOT be compacted — it is the current turn',
    );
  });

  it('compacts a ToolMessage from a prior turn', () => {
    // Prior turn
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'search',
          args: { q: 'something' },
          id: 'old',
          type: 'tool_call',
        },
      ],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'old',
      name: 'search',
      content:
        'A large result that should be replaced by a compact evidence record. ' +
        'filler '.repeat(40) +
        'TAIL_BEYOND_200',
    });
    // Current turn — last AI message, no tool calls pending
    const currentAi = new AIMessage({ content: 'Done.' });

    const history = [new HumanMessage('go'), priorAi, priorTool, currentAi];
    const out = compactPriorToolResults(history);

    // A new array was allocated (something changed)
    expect(out).not.toBe(history);
    // Non-tool messages are the same object references (not cloned unnecessarily)
    expect(out[0]).toBe(history[0]);
    expect(out[1]).toBe(history[1]);
    expect(out[3]).toBe(history[3]);

    const compacted = out[2] as ToolMessage;
    expect(compacted.tool_call_id).toBe('old');
    expect(compacted.name).toBe('search');
    const body = compacted.content as string;
    expect(body).toContain('[Tool: search]');
    expect(body).toContain('Args:');
    expect(body).toContain('Result:');
    expect(body).toContain('(full result in transcript)');
    // Content past the 200-char cap is truncated
    expect(body).toContain('…');
    expect(body).not.toContain('TAIL_BEYOND_200');
  });

  it('compacts prior-turn results but keeps the current-turn result full when both are present', () => {
    // Prior turn
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: {}, id: 'old', type: 'tool_call' }],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'old',
      name: 'recall',
      content:
        'prior result — should be compacted. ' +
        'filler '.repeat(40) +
        'TAIL_BEYOND_200',
    });
    // Current turn (model just called a tool, results are in-flight)
    const currAi = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'list_worktrees',
          args: { botId: 'alex' },
          id: 'new',
          type: 'tool_call',
        },
      ],
    });
    const currTool = new ToolMessage({
      tool_call_id: 'new',
      name: 'list_worktrees',
      content: 'current result — must stay full',
    });

    const history = [priorAi, priorTool, currAi, currTool];
    const out = compactPriorToolResults(history);

    expect(out).not.toBe(history); // prior was compacted → new array
    // Current-turn result unchanged
    expect((out[3] as ToolMessage).content).toBe(
      'current result — must stay full',
    );
    // Prior-turn result compacted
    const compacted = out[1] as ToolMessage;
    expect(compacted.content).toContain('[Tool: recall]');
    expect(compacted.content).toContain('(full result in transcript)');
    expect(compacted.content).toContain('…');
    expect(compacted.content).not.toContain('TAIL_BEYOND_200');
  });

  it('truncates args JSON to 100 chars with an ellipsis', () => {
    const longValue = 'x'.repeat(200);
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'tool',
          args: { key: longValue },
          id: 'old',
          type: 'tool_call',
        },
      ],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'old',
      name: 'tool',
      content: 'short result',
    });
    // Last AI message — no tool calls (marks current turn boundary)
    const currAi = new AIMessage({ content: 'ok' });

    const history = [priorAi, priorTool, currAi];
    const out = compactPriorToolResults(history);
    const body = (out[1] as ToolMessage).content as string;

    // Extract the args section (between "Args: " and " Result:")
    const argsMatch = body.match(/Args: (.*?) Result:/);
    expect(argsMatch).not.toBeNull();
    const argsSection = argsMatch![1];
    // Should end with ellipsis and its text part ≤ 100 chars
    expect(argsSection).toMatch(/…$/);
    expect(argsSection.replace(/…$/, '').length).toBeLessThanOrEqual(100);
  });

  it('truncates result to 200 chars with an ellipsis', () => {
    const longResult = 'r'.repeat(500);
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'tool', args: {}, id: 'old', type: 'tool_call' }],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'old',
      name: 'tool',
      content: longResult,
    });
    const currAi = new AIMessage({ content: 'ok' });

    const history = [priorAi, priorTool, currAi];
    const out = compactPriorToolResults(history);
    const body = (out[1] as ToolMessage).content as string;

    // Extract the result section (between "Result: " and " (full result in transcript)")
    const resultMatch = body.match(
      /Result: (.*?) \(full result in transcript\)/,
    );
    expect(resultMatch).not.toBeNull();
    const resultSection = resultMatch![1];
    expect(resultSection).toMatch(/…$/);
    expect(resultSection.replace(/…$/, '').length).toBeLessThanOrEqual(200);
  });

  it('does not truncate short args or results', () => {
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [
        { name: 'ping', args: { ok: true }, id: 'p1', type: 'tool_call' },
      ],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'p1',
      name: 'ping',
      content: 'pong',
    });
    const currAi = new AIMessage({ content: 'done' });

    const history = [priorAi, priorTool, currAi];
    const body = (compactPriorToolResults(history)[1] as ToolMessage)
      .content as string;

    // No ellipsis injected for short content
    expect(body).not.toContain('…');
    expect(body).toContain('{"ok":true}');
    expect(body).toContain('pong');
  });

  it('handles a ToolMessage with no matching AI-message args gracefully', () => {
    // An orphan ToolMessage (id not present in any AI message tool_calls).
    // Shouldn't happen in practice but must not crash.
    const currAi = new AIMessage({ content: 'hi' }); // no tool_calls
    const orphan = new ToolMessage({
      tool_call_id: 'no-such-call',
      name: 'phantom',
      content: 'some content',
    });
    const history = [orphan, currAi];
    const out = compactPriorToolResults(history);
    const body = (out[0] as ToolMessage).content as string;
    expect(body).toContain('[Tool: phantom]');
    expect(body).toContain('(full result in transcript)');
  });

  it('compacts multiple prior-turn ToolMessages in one pass', () => {
    const ai1 = new AIMessage({
      content: '',
      tool_calls: [
        { name: 'a', args: { x: 1 }, id: 'id-a', type: 'tool_call' },
        { name: 'b', args: { y: 2 }, id: 'id-b', type: 'tool_call' },
      ],
    });
    const tool1a = new ToolMessage({
      tool_call_id: 'id-a',
      name: 'a',
      content: 'result-a',
    });
    const tool1b = new ToolMessage({
      tool_call_id: 'id-b',
      name: 'b',
      content: 'result-b',
    });
    // Current AI — final turn, no pending tool calls
    const ai2 = new AIMessage({ content: 'all done' });

    const history = [ai1, tool1a, tool1b, ai2];
    const out = compactPriorToolResults(history);

    expect(out).not.toBe(history);
    expect((out[1] as ToolMessage).content).toContain('[Tool: a]');
    expect((out[2] as ToolMessage).content).toContain('[Tool: b]');
    // tool_call_ids preserved
    expect((out[1] as ToolMessage).tool_call_id).toBe('id-a');
    expect((out[2] as ToolMessage).tool_call_id).toBe('id-b');
  });

  it('includes args in the compacted body from the matching AI message', () => {
    const priorAi = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'recall',
          args: { query: 'auth flow' },
          id: 'r1',
          type: 'tool_call',
        },
      ],
    });
    const priorTool = new ToolMessage({
      tool_call_id: 'r1',
      name: 'recall',
      content: 'Here are the facts about auth flow...',
    });
    const currAi = new AIMessage({ content: 'noted' });

    const history = [priorAi, priorTool, currAi];
    const body = (compactPriorToolResults(history)[1] as ToolMessage)
      .content as string;
    expect(body).toContain('"auth flow"');
  });
});

/**
 * Unit tests for filterToolDispatchMessages — read-time filter that removes text-less
 * AI tool-dispatch messages and their paired ToolMessages from history.
 *
 * Contract:
 *  - AI messages with empty/null content AND tool_calls are "dispatch" messages.
 *  - Their corresponding ToolMessages are removed together (pairing must stay consistent).
 *  - The LAST AI message is never filtered (current-turn boundary).
 *  - AI messages with text (even if they also have tool_calls) are kept.
 *  - Returns the same array reference when nothing was filtered.
 */
describe('filterToolDispatchMessages', () => {
  it('returns the same reference when there are no tool-dispatch messages', () => {
    const history = [
      new HumanMessage('hi'),
      new AIMessage('hello'),
    ];
    expect(filterToolDispatchMessages(history)).toBe(history);
  });

  it('returns the same reference when the only dispatch is the last AI message', () => {
    const lastAi = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: {}, id: 'c1', type: 'tool_call' }],
    });
    const history = [new HumanMessage('do something'), lastAi];
    // lastAi is the last AI message — must NOT be filtered
    expect(filterToolDispatchMessages(history)).toBe(history);
  });

  it('filters a prior-turn text-less dispatch and its tool result', () => {
    const dispatch = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: { query: 'foo' }, id: 'd1', type: 'tool_call' }],
    });
    const toolResult = new ToolMessage({
      tool_call_id: 'd1',
      name: 'recall',
      content: 'some recalled data',
    });
    const finalAi = new AIMessage({ content: 'Here is my answer.' });

    const history = [dispatch, toolResult, finalAi];
    const out = filterToolDispatchMessages(history);

    expect(out).not.toBe(history); // a new array was allocated
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(finalAi);
  });

  it('keeps an AI message that has text even if it also has tool_calls', () => {
    const textAndTools = new AIMessage({
      content: 'Let me look that up.',
      tool_calls: [{ name: 'search', args: {}, id: 't1', type: 'tool_call' }],
    });
    const toolResult = new ToolMessage({
      tool_call_id: 't1',
      name: 'search',
      content: 'result',
    });
    const finalAi = new AIMessage({ content: 'Done.' });

    const history = [textAndTools, toolResult, finalAi];
    const out = filterToolDispatchMessages(history);

    // textAndTools has text — it must not be filtered
    expect(out).toBe(history);
  });

  it('keeps the last AI message even when it is a text-less dispatch', () => {
    const priorDispatch = new AIMessage({
      content: '',
      tool_calls: [{ name: 'a', args: {}, id: 'p1', type: 'tool_call' }],
    });
    const priorTool = new ToolMessage({ tool_call_id: 'p1', name: 'a', content: 'r1' });
    const currentDispatch = new AIMessage({
      content: '',
      tool_calls: [{ name: 'b', args: {}, id: 'c1', type: 'tool_call' }],
    });

    const history = [priorDispatch, priorTool, currentDispatch];
    const out = filterToolDispatchMessages(history);

    // priorDispatch + priorTool filtered; currentDispatch (last AI) kept
    expect(out).not.toBe(history);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(currentDispatch);
  });

  it('filters multiple prior-turn dispatches in one pass', () => {
    const d1 = new AIMessage({
      content: '',
      tool_calls: [{ name: 'a', args: {}, id: 'id1', type: 'tool_call' }],
    });
    const t1 = new ToolMessage({ tool_call_id: 'id1', name: 'a', content: 'r1' });
    const d2 = new AIMessage({
      content: '',
      tool_calls: [{ name: 'b', args: {}, id: 'id2', type: 'tool_call' }],
    });
    const t2 = new ToolMessage({ tool_call_id: 'id2', name: 'b', content: 'r2' });
    const final = new AIMessage({ content: 'Done.' });

    const history = [d1, t1, d2, t2, final];
    const out = filterToolDispatchMessages(history);

    expect(out).not.toBe(history);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(final);
  });

  it('keeps human messages and non-dispatch tool messages intact', () => {
    const human = new HumanMessage('question');
    // An AI message with text that has tool_calls — NOT a dispatch
    const aiWithText = new AIMessage({
      content: 'Checking…',
      tool_calls: [{ name: 'search', args: {}, id: 's1', type: 'tool_call' }],
    });
    const toolMsg = new ToolMessage({ tool_call_id: 's1', name: 'search', content: 'result' });
    const lastAi = new AIMessage({ content: 'Answer.' });

    const history = [human, aiWithText, toolMsg, lastAi];
    expect(filterToolDispatchMessages(history)).toBe(history);
  });
});

// ---------------------------------------------------------------------------
// dropLeadingOrphanToolResults
// ---------------------------------------------------------------------------

/**
 * Unit tests for dropLeadingOrphanToolResults — READ-TIME heal that strips a contiguous
 * leading ToolMessage block from a compacted tail.
 *
 * Contract:
 *  - Returns the same reference when the first message is NOT a tool (nothing to drop).
 *  - Strips one or more contiguous leading ToolMessages.
 *  - Stops at the first non-tool message (does NOT remove ToolMessages mid-history).
 *  - Returns [] when the entire history is tool messages.
 */
describe('dropLeadingOrphanToolResults', () => {
  it('returns same reference when history does not start with a tool message', () => {
    const history = [new HumanMessage('hi'), new AIMessage('hello')];
    expect(dropLeadingOrphanToolResults(history)).toBe(history);
  });

  it('returns same reference for an empty array', () => {
    const history: BaseMessage[] = [];
    expect(dropLeadingOrphanToolResults(history)).toBe(history);
  });

  it('drops a single leading ToolMessage', () => {
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'recall', content: 'orphan' });
    const ai = new AIMessage({ content: 'reply' });
    const history = [tool, ai];
    const out = dropLeadingOrphanToolResults(history);
    expect(out).not.toBe(history);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ai);
  });

  it('drops multiple contiguous leading ToolMessages', () => {
    const t1 = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r1' });
    const t2 = new ToolMessage({ tool_call_id: 't2', name: 'b', content: 'r2' });
    const ai = new AIMessage({ content: 'next' });
    const human = new HumanMessage('after');
    const history = [t1, t2, ai, human];
    const out = dropLeadingOrphanToolResults(history);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ai);
    expect(out[1]).toBe(human);
  });

  it('returns [] when the entire array is ToolMessages', () => {
    const history = [
      new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r1' }),
      new ToolMessage({ tool_call_id: 't2', name: 'b', content: 'r2' }),
    ];
    expect(dropLeadingOrphanToolResults(history)).toHaveLength(0);
  });

  it('does not remove ToolMessages that are NOT at the leading position', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'a', args: {}, id: 't1', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'result' });
    const history = [ai, tool];
    expect(dropLeadingOrphanToolResults(history)).toBe(history);
  });
});

// ---------------------------------------------------------------------------
// pairSafeBoundary
// ---------------------------------------------------------------------------

/**
 * Unit tests for pairSafeBoundary — ensures the compaction cut never splits a
 * tool_use/tool_result group and always lands at a HumanMessage boundary.
 *
 * Contract:
 *  - Cut already on a HumanMessage → returned unchanged.
 *  - Cut on a ToolMessage → walks back past the AI owner to the preceding Human.
 *  - Cut inside a parallel block (≥2 results) → walks across all results and the owner AI to Human.
 *  - Walk crosses `floor` → returns `floor` (caller bails).
 *  - Corrupt source: preceding message is not AI → returns `floor`.
 *  - Corrupt source: preceding AI whose tool_calls don't cover all ids → returns `floor`.
 *  - Cut on a final AIMessage (no following tool) → walks back to preceding Human.
 *  - Cut inside tool results followed by more context → walks all the way to Human.
 */
describe('pairSafeBoundary', () => {
  it('returns rawCut unchanged when it already lands on a HumanMessage', () => {
    const messages = [
      new HumanMessage('user'),
      new AIMessage({ content: 'reply' }),
      new HumanMessage('next'),
    ];
    expect(pairSafeBoundary(messages, 2, 0)).toBe(2);
  });

  it('walks back a tool_result and its AI owner to the Human boundary', () => {
    // idx: 0=Human(earlier), 1=AI(reply), 2=Human(h), 3=AI(tool_use t1), 4=Tool(t1)
    // rawCut=4: (a) walks to AI(3), (b) ownership OK, (c) walks to Human(2)
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: {}, id: 't1', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'recall', content: 'r' });
    const messages = [
      new HumanMessage('earlier'),
      new AIMessage({ content: 'prior reply' }),
      new HumanMessage('h'),
      ai,
      tool,
    ];
    expect(pairSafeBoundary(messages, 4, 0)).toBe(2);
  });

  it('walks back a parallel block of 2 results all the way to the Human boundary', () => {
    // idx: 0=Human(earlier), 1=AI(reply), 2=Human(h), 3=AI(t1,t2), 4=Tool(t1), 5=Tool(t2), 6=Human
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        { name: 'a', args: {}, id: 't1', type: 'tool_call' },
        { name: 'b', args: {}, id: 't2', type: 'tool_call' },
      ],
    });
    const tool1 = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r1' });
    const tool2 = new ToolMessage({ tool_call_id: 't2', name: 'b', content: 'r2' });
    const messages = [
      new HumanMessage('earlier'),
      new AIMessage({ content: 'prior reply' }),
      new HumanMessage('h'),
      ai,
      tool1,
      tool2,
      new HumanMessage('next'),
    ];
    // rawCut=5 (second Tool) → tool walk-back to AI(3) → Human walk-back to Human(2)
    expect(pairSafeBoundary(messages, 5, 0)).toBe(2);
    // rawCut=4 (first Tool) → same path → Human(2)
    expect(pairSafeBoundary(messages, 4, 0)).toBe(2);
  });

  it('returns floor when walking back would cross floor', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'a', args: {}, id: 't1', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r' });
    const messages = [new HumanMessage('h'), ai, tool];
    // rawCut=2 (tool), floor=2 → b<=floor immediately → floor
    expect(pairSafeBoundary(messages, 2, 2)).toBe(2);
    // rawCut=2 (tool), floor=1 → tool walk to b=1 (AI), b<=floor (1<=1) → floor=1
    expect(pairSafeBoundary(messages, 2, 1)).toBe(1);
  });

  it('returns floor when the message preceding the tool block is not an AI', () => {
    // idx: 0=Human, 1=Human, 2=Tool — no AI owner; ownership check fires early (b).
    const messages = [
      new HumanMessage('prior context'),
      new HumanMessage('more context'),
      new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r' }),
    ];
    // rawCut=2 on tool → (a) walks to b=1 (Human) → (b) messages[2]='tool', owner is Human → floor
    expect(pairSafeBoundary(messages, 2, 0)).toBe(0);
  });

  it('returns floor when the AI tool_calls do not cover the following tool ids', () => {
    // idx: 0=Human, 1=AI(id='x'), 2=Tool(id='t1') — id mismatch.
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'a', args: {}, id: 'x', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r' });
    const messages = [new HumanMessage('h'), ai, tool];
    // rawCut=2 on tool → (a) walks to b=1 (AI) → (b) id mismatch → floor
    expect(pairSafeBoundary(messages, 2, 0)).toBe(0);
  });

  it('walks back to the Human boundary when the AI fully covers the tool block', () => {
    // idx: 0=Human(earlier), 1=AI(reply), 2=Human(h), 3=AI(t1,t2), 4=Tool(t1), 5=Tool(t2), 6=AI(done)
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        { name: 'a', args: {}, id: 't1', type: 'tool_call' },
        { name: 'b', args: {}, id: 't2', type: 'tool_call' },
      ],
    });
    const t1 = new ToolMessage({ tool_call_id: 't1', name: 'a', content: 'r1' });
    const t2 = new ToolMessage({ tool_call_id: 't2', name: 'b', content: 'r2' });
    const reply = new AIMessage({ content: 'done' });
    const messages = [
      new HumanMessage('earlier'),
      new AIMessage({ content: 'prior reply' }),
      new HumanMessage('h'),
      ai,
      t1,
      t2,
      reply,
    ];
    // rawCut=6 (final AI reply, no following tool): (c) walks 6→5→4→3→2 (Human) → 2
    expect(pairSafeBoundary(messages, 6, 0)).toBe(2);
    // rawCut=5 (t2): (a) walks to AI(3), (b) ownership OK, (c) walks to Human(2) → 2
    expect(pairSafeBoundary(messages, 5, 0)).toBe(2);
  });

  // --- Three new cases proving the Human-boundary guarantee ---

  it('walks back to the preceding Human when the raw cut lands on an AIMessage reply', () => {
    // idx: 0=Human, 1=AI, 2=Human, 3=AI
    // rawCut=3 (second AI): step (a) no walk, (b) no following tool, (c) walks 3→2 (Human) → 2
    const messages = [
      new HumanMessage('first prompt'),
      new AIMessage({ content: 'first reply' }),
      new HumanMessage('second prompt'),
      new AIMessage({ content: 'second reply' }),
    ];
    expect(pairSafeBoundary(messages, 3, 0)).toBe(2);
  });

  it('returns floor when tool walk-back lands on an AI whose Human boundary is at floor', () => {
    // idx: 0=Human, 1=AI(tool_call t1), 2=Tool(t1), 3=AI
    // rawCut=2: (a) walks to AI(1), (b) ownership OK, (c) walks to Human(0)=floor → floor
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: {}, id: 't1', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'recall', content: 'r' });
    const messages = [
      new HumanMessage('h'),
      ai,
      tool,
      new AIMessage({ content: 'done' }),
    ];
    // Human(0) == floor(0) → b<=floor → return floor=0
    expect(pairSafeBoundary(messages, 2, 0)).toBe(0);
  });

  it('returns floor when the final AI after a tool block has its Human boundary at floor', () => {
    // idx: 0=Human, 1=AI(tool_call t1), 2=Tool(t1), 3=AI(final reply)
    // rawCut=3: (a) no walk (AI), (b) no following tool, (c) walks 3→2→1→0 (Human=floor) → floor
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ name: 'recall', args: {}, id: 't1', type: 'tool_call' }],
    });
    const tool = new ToolMessage({ tool_call_id: 't1', name: 'recall', content: 'r' });
    const messages = [
      new HumanMessage('h'),
      ai,
      tool,
      new AIMessage({ content: 'final reply' }),
    ];
    // Human(0) == floor(0) → floor
    expect(pairSafeBoundary(messages, 3, 0)).toBe(0);
  });
});

