import { describe, expect, it } from 'bun:test';
import { ECliCommand, JOB_ID_ENV, isCliInvocation, parseInvocation } from '../invocation.js';

const NO_ENV: Record<string, string | undefined> = {};
const IN_TURN: Record<string, string | undefined> = { [JOB_ID_ENV]: 'job-from-env' };

describe('isCliInvocation', () => {
  it('claims only exact subcommand names', () => {
    expect(isCliInvocation(['threads'])).toBe(true);
    expect(isCliInvocation(['transcript', 'abc'])).toBe(true);
    expect(isCliInvocation(['map'])).toBe(true);
    expect(isCliInvocation(['ticket', '3'])).toBe(true);
    expect(isCliInvocation(['help'])).toBe(true);
  });

  it('leaves a bare path to the TUI — `atlas ~/code/atlas` opens a folder', () => {
    expect(isCliInvocation([])).toBe(false);
    expect(isCliInvocation(['/Users/dennis/Developer/atlas'])).toBe(false);
    expect(isCliInvocation(['--here'])).toBe(false);
    // Near-misses are paths, not typos to guess at.
    expect(isCliInvocation(['thread'])).toBe(false);
  });
});

describe('parseInvocation', () => {
  it('defaults the job to the turn environment', () => {
    const parsed = parseInvocation({ args: ['threads'], env: IN_TURN });
    expect(parsed).toEqual({
      ok: true,
      command: { name: ECliCommand.threads, jobId: 'job-from-env' },
    });
  });

  it('lets --job reach across jobs, overriding the environment', () => {
    const parsed = parseInvocation({ args: ['map', '--job', 'other'], env: IN_TURN });
    expect(parsed).toEqual({ ok: true, command: { name: ECliCommand.map, jobId: 'other' } });
  });

  it('accepts --job=<id> as well', () => {
    const parsed = parseInvocation({ args: ['map', '--job=other'], env: NO_ENV });
    expect(parsed).toEqual({ ok: true, command: { name: ECliCommand.map, jobId: 'other' } });
  });

  it('says how to name a job when there is none', () => {
    const parsed = parseInvocation({ args: ['threads'], env: NO_ENV });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--job');
    expect(parsed.message).toContain(JOB_ID_ENV);
  });

  it('reads a ticket by number, padded or not — the number is the identity', () => {
    for (const value of ['3', '03']) {
      expect(parseInvocation({ args: ['ticket', value], env: IN_TURN })).toEqual({
        ok: true,
        command: { name: ECliCommand.ticket, jobId: 'job-from-env', ticketNumber: 3 },
      });
    }
  });

  it('rejects a ticket that is not a number', () => {
    const parsed = parseInvocation({ args: ['ticket', 'charting-shape'], env: IN_TURN });
    expect(parsed.ok).toBe(false);
  });

  it('takes a thread id positionally and needs no job', () => {
    expect(parseInvocation({ args: ['transcript', 'thread-1'], env: NO_ENV })).toEqual({
      ok: true,
      command: { name: ECliCommand.transcript, threadId: 'thread-1', full: false },
    });
  });

  it('carries --full through to the transcript', () => {
    expect(parseInvocation({ args: ['transcript', 'thread-1', '--full'], env: NO_ENV })).toEqual({
      ok: true,
      command: { name: ECliCommand.transcript, threadId: 'thread-1', full: true },
    });
  });

  it('asks for the thread id rather than guessing one', () => {
    const parsed = parseInvocation({ args: ['transcript'], env: IN_TURN });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('thread id');
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // A dropped `--job` would read the WRONG job and look like a correct answer.
    const parsed = parseInvocation({ args: ['threads', '--jobb', 'x'], env: IN_TURN });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('--jobb');
  });

  it('rejects --job with nothing after it', () => {
    expect(parseInvocation({ args: ['threads', '--job'], env: IN_TURN }).ok).toBe(false);
    expect(parseInvocation({ args: ['threads', '--job', '--full'], env: IN_TURN }).ok).toBe(false);
  });

  it('has no write subcommand — writes cross a seam a shell cannot record', () => {
    for (const write of ['advance_phase', 'complete_thread', 'open_thread', 'write']) {
      expect(parseInvocation({ args: [write], env: IN_TURN }).ok).toBe(false);
    }
  });
});
