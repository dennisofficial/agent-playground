import { PromptFragment } from '@dltech/atlas-core'


export class CompactionNoticeFragment extends PromptFragment {
  readonly id = 'workflow.compaction-notice'

  text(): string {
    return [
      'This conversation is compacted when it grows long: the earlier turns are replaced by a summary',
      'and you will not be able to read them again. Write anything you will need later into your own',
      'output or into a file, rather than relying on scrolling back.',
    ].join('\n')
  }
}
