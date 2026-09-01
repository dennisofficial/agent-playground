import { PromptFragment } from '@dltech/atlas-core'

import { injectable } from '../../container/injection'

@injectable()
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
      'refused until you have read it again.',
    ].join('\n')
  }
}
