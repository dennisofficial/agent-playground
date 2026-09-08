import { PromptFragment } from '@dltech/atlas-core'


export class ReadBeforeWriteFragment extends PromptFragment {
  readonly id = 'files.read-before-write'

  text(): string {
    return [
      'write replaces a file whole, so an existing file has to have been read whole before you may',
      'replace it. read gives you that; grep gives you only the lines it matched; reading a file through',
      'the shell gives you nothing that is tracked at all. edit needs no prior read, because its old text',
      'has to match — an unanchored change fails rather than lands.',
      '',
      'Every file you have read is watched. If it changes underneath you, the next write or edit to it is',
      'refused until you have read it again. A read vouches only for the exact path it read: the same',
      'file under another checkout or worktree is a different file, and is unread until you read it there.',
      '',
      'Instruction files (CLAUDE.md, AGENTS.md, ATLAS.md) and memory indexes whose contents were',
      'injected into this conversation already count as read — write or edit them directly rather than',
      'reading them again first. The staleness refusal still applies if one changed since it was shown.',
    ].join('\n')
  }
}

export class ReadWideFragment extends PromptFragment {
  readonly id = 'files.read-wide'

  text(): string {
    return [
      'Read a file whole unless you already know it is enormous. Slicing it into offsets costs a round',
      'trip each and leaves you holding a partial view, which is the one thing that will not unlock a',
      'write — and a later grep over a file you had read whole drops it back to partial, because a',
      'search proves only that those lines were seen.',
    ].join('\n')
  }
}
