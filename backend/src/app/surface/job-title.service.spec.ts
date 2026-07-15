import { RunnableLambda } from '@langchain/core/runnables';
import { describe, expect, it, vi } from 'vitest';
import { JobTitleService } from './job-title.service';
import {
  sanitizeTitle,
  type JobTitleChainFactory,
} from '../titling/job-title.chain';

/**
 * Unit tests for the job-title service. The LLM is faked behind the `JOB_TITLE_CHAIN` factory (a
 * `RunnableLambda`), so no network — we pin the compare-and-set persist + the live-frame emission rules.
 */

/** A factory that returns a chain yielding `title` (or throwing). `null` factory result = no key. */
function fakeFactory(
  title: string | null,
  opts: { throws?: boolean } = {},
): JobTitleChainFactory {
  return async () => {
    if (title === null && !opts.throws) return undefined;
    return RunnableLambda.from<{ message: string }, string>(async () => {
      if (opts.throws) throw new Error('boom');
      return title ?? '';
    });
  };
}

function makeService(
  factory: JobTitleChainFactory,
  updateResult: { affected: number },
) {
  const emitThreadMeta = vi.fn();
  const update = vi.fn(
    async (_where: unknown, _patch: { title: string }) => updateResult,
  );
  const surface = { emitThreadMeta } as never;
  const threads = { update } as never;
  const service = new JobTitleService(factory, surface, threads);
  return { service, emitThreadMeta, update };
}

describe('JobTitleService.generateAndApply', () => {
  it('persists the sanitized title and emits a live frame when a row changed', async () => {
    const { service, emitThreadMeta, update } = makeService(
      fakeFactory('  "Repo Architecture"  '),
      {
        affected: 1,
      },
    );
    await service.generateAndApply(
      't1',
      'org1',
      'repo1',
      'walk me through the architecture',
      null,
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toEqual({ title: 'Repo Architecture' });
    expect(emitThreadMeta).toHaveBeenCalledWith(
      'repo1',
      't1',
      'Repo Architecture',
    );
  });

  it('does NOT emit when no row changed (placeholder already renamed / thread deleted)', async () => {
    const { service, emitThreadMeta, update } = makeService(
      fakeFactory('A Title'),
      { affected: 0 },
    );
    await service.generateAndApply(
      't1',
      'org1',
      'repo1',
      'hello',
      'placeholder',
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(emitThreadMeta).not.toHaveBeenCalled();
  });

  it('no-ops (no update, no emit) when no Anthropic key resolves', async () => {
    const { service, emitThreadMeta, update } = makeService(fakeFactory(null), {
      affected: 1,
    });
    await service.generateAndApply('t1', 'org1', 'repo1', 'hello', null);
    expect(update).not.toHaveBeenCalled();
    expect(emitThreadMeta).not.toHaveBeenCalled();
  });

  it('skips when the generated title equals the existing placeholder', async () => {
    const { service, emitThreadMeta, update } = makeService(
      fakeFactory('Same'),
      { affected: 1 },
    );
    await service.generateAndApply('t1', 'org1', 'repo1', 'hello', 'Same');
    expect(update).not.toHaveBeenCalled();
    expect(emitThreadMeta).not.toHaveBeenCalled();
  });

  it('swallows an LLM error (never throws, no update)', async () => {
    const { service, emitThreadMeta, update } = makeService(
      fakeFactory('x', { throws: true }),
      {
        affected: 1,
      },
    );
    await expect(
      service.generateAndApply('t1', 'org1', 'repo1', 'hello', null),
    ).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(emitThreadMeta).not.toHaveBeenCalled();
  });
});

describe('sanitizeTitle', () => {
  it('strips surrounding quotes, collapses whitespace, caps length', () => {
    expect(sanitizeTitle('  "Hello   World"  ')).toBe('Hello World');
    expect(sanitizeTitle("'Single Quoted'")).toBe('Single Quoted');
    expect(sanitizeTitle('a'.repeat(200))?.length).toBe(80);
  });

  it('returns undefined for empty / whitespace-only output', () => {
    expect(sanitizeTitle('')).toBeUndefined();
    expect(sanitizeTitle('   ')).toBeUndefined();
    expect(sanitizeTitle('""')).toBeUndefined();
  });

  it('rejects refusal / assistant-talking output so the caller can fall back', () => {
    expect(
      sanitizeTitle(
        "I appreciate the question, but I'm designed to write task titles",
      ),
    ).toBeUndefined();
    expect(sanitizeTitle("Sorry, I can't help with that")).toBeUndefined();
    expect(
      sanitizeTitle("Sure, here's a title: Repo Overview"),
    ).toBeUndefined();
    expect(sanitizeTitle('The title is Repo Overview')).toBeUndefined();
    // A real noun-phrase title still passes.
    expect(sanitizeTitle('Repo Overview')).toBe('Repo Overview');
    expect(sanitizeTitle('Image Upload Pipeline')).toBe(
      'Image Upload Pipeline',
    );
  });
});
