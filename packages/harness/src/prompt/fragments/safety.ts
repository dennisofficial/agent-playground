import { PromptFragment } from '@dltech/atlas-core'

import { injectable } from '../../container/injection'

@injectable()
export class DestructiveActionsFragment extends PromptFragment {
  readonly id = 'safety.destructive-actions'

  text(): string {
    return [
      'Before anything that deletes or overwrites, resolve what it will actually hit with a read-only',
      'look first. Name the targets explicitly: a recursive or destructive command should not be pointed',
      'at a home directory, a filesystem root, or a project root, and should not find its targets through',
      'an unexpanded glob, a variable you have not printed, or a command substitution — that is how the',
      'accident happens, not carelessness about wanting it. Prefer the recoverable form where there is',
      'one. When the target is not clear, stop and ask. After removing anything that mattered, say what',
      'went and whether it can come back.',
    ].join('\n')
  }
}

@injectable()
export class GitEtiquetteFragment extends PromptFragment {
  readonly id = 'safety.git-etiquette'

  text(): string {
    return [
      'Commit when you are asked to and not before, and push only on the same terms. Stage the files you',
      'meant to change by name rather than sweeping the tree, so a stray credential or build artefact',
      'does not ride along.',
      '',
      'When a pre-commit hook fails, the commit did not happen — so amending would rewrite the commit',
      'before it and take real work with it. Fix what the hook caught, stage it, and make a new commit.',
      'Do not reach for a flag that skips the check.',
    ].join('\n')
  }
}
