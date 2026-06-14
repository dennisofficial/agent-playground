import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  compactPriorToolResults,
  filterToolDispatchMessages,
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
        'A large result that should be replaced by a compact evidence record',
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
    // Original bulky content is gone
    expect(body).not.toContain(
      'A large result that should be replaced by a compact evidence record',
    );
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
      content: 'prior result — should be compacted',
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
    expect(compacted.content).not.toContain(
      'prior result — should be compacted',
    );
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

