import { describe, expect, it } from 'bun:test';
import { classifyToolFault, EToolFault } from '../tool-fault.js';

describe('sorting a thrown value into refusal or harness fault', () => {
  it('treats a deliberate Error as a refusal and hands its message back untouched', () => {
    // The exact shape of every real refusal in `app/`: prose, thrown as a plain Error, written to
    // be read by the agent. Nothing may be added to it — see the comment in `classifyToolFault`.
    const message =
      'the charting phase does not host a builder thread you may open — you may open charting, research';
    const fault = classifyToolFault({
      tool: 'advance_thread',
      error: new Error(message),
    });

    expect(fault.kind).toBe(EToolFault.refusal);
    expect(fault.reply).toBe(message);
    expect(fault.detail).toBeNull();
  });

  it('calls a ReferenceError a harness fault — the bug this module was written for', () => {
    // Verbatim from `~/.atlas/sessions/85aa…/raw.jsonl`: a half-applied `rolesFor → agentRolesFor`
    // rename reached the agent as `rolesFor is not defined`, which reads exactly like a refusal
    // about roles. If this ever classifies as one again, the same afternoon repeats.
    const fault = classifyToolFault({
      tool: 'advance_thread',
      error: new ReferenceError('rolesFor is not defined'),
    });

    expect(fault.kind).toBe(EToolFault.harness);
    expect(fault.reply).toContain('ReferenceError: rolesFor is not defined');
    expect(fault.reply).toContain('not a mistake in your call');
    expect(fault.reply).toContain('do not retry it');
  });

  it('names the tool in both halves, because a fault log with no tool in it is a guess', () => {
    const fault = classifyToolFault({
      tool: 'open_thread',
      error: new TypeError("undefined is not an object (evaluating 'this.repo.findById')"),
    });

    expect(fault.reply).toContain('`open_thread`');
    expect(fault.detail).toContain('open_thread');
  });

  it('carries the stack into the detail and keeps it out of the agent’s reply', () => {
    const error = new RangeError('too far');
    const fault = classifyToolFault({ tool: 'rotate', error });

    expect(fault.detail).toContain(error.stack ?? 'no stack');
    // The agent gets a sentence, never a stack — that was true of refusals and stays true here.
    // Asserted through the frames' own filename, which only a real stack would put in the string.
    expect(fault.reply).not.toContain('tool-fault.spec');
    expect(fault.reply).not.toContain('\n');
  });

  it('treats every engine-minted error type as a harness fault, not just the one that bit us', () => {
    for (const error of [
      new ReferenceError('x'),
      new TypeError('x'),
      new RangeError('x'),
      new SyntaxError('x'),
      new EvalError('x'),
    ]) {
      expect(classifyToolFault({ tool: 'ship', error }).kind).toBe(EToolFault.harness);
    }
  });

  it('treats a throw that is not an Error at all as a harness fault', () => {
    // Nothing in Atlas throws a bare value deliberately, and a value with no message is one the
    // agent could not act on even if it were a refusal.
    const fault = classifyToolFault({ tool: 'task_update', error: 'kaboom' });

    expect(fault.kind).toBe(EToolFault.harness);
    expect(fault.reply).toContain('kaboom');
    expect(fault.detail).toContain('task_update');
  });

  it('leaves a subclass Atlas might define of its own as a refusal', () => {
    // The denylist is deliberate: an unrecognised error name means "somebody threw this on purpose",
    // and only the engine's own constructors are assumed to be bugs.
    class ShipRefusal extends Error {
      override name = 'ShipRefusal';
    }
    const fault = classifyToolFault({ tool: 'ship', error: new ShipRefusal('rebase first') });

    expect(fault.kind).toBe(EToolFault.refusal);
    expect(fault.reply).toBe('rebase first');
  });
});
