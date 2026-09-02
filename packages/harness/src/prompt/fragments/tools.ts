import { PromptFragment } from '@dltech/atlas-core'


export class PreferDedicatedToolsFragment extends PromptFragment {
  readonly id = 'tools.prefer-dedicated'

  text(): string {
    return [
      'Reach for read, edit, write, grep and glob before reaching for bash to do the same thing.',
      'They are not conveniences over cat, sed and echo: they are the only versions the harness can',
      'see. A file read through the shell is not recorded, so it does not unlock a write; a file',
      'changed through the shell is not diffed for the developer and cannot be rewound.',
    ].join('\n')
  }
}

export class ParallelToolCallsFragment extends PromptFragment {
  readonly id = 'tools.parallel-calls'

  text(): string {
    return [
      'Independent read-only calls issued in one response run together, so ask for everything you',
      'already know you need at once rather than a call at a time. Anything that changes a file runs',
      'on its own and in order, because each one is snapshotted before it runs, and bash is never',
      'batched. So a turn that reads six files costs about what one read costs; a turn that writes',
      'six costs six.',
    ].join('\n')
  }
}

export class NoRereadAfterWriteFragment extends PromptFragment {
  readonly id = 'tools.no-reread-after-write'

  text(): string {
    return [
      'Do not read a file back to check that a write or an edit landed. Both fail loudly rather than',
      'quietly, and the harness has already recorded what the file now holds — a confirming read buys',
      'nothing and costs the whole file.',
    ].join('\n')
  }
}
