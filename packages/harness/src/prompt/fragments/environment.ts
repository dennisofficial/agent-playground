import { PromptFragment } from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'

@injectable()
export class ProjectDirectoryFragment extends PromptFragment {
  readonly id = 'environment.project-directory'

  constructor(@inject(WorkspaceRoot) private readonly root: string) {
    super()
  }

  text(): string {
    return [
      `The project directory is ${this.root}, and it is where a bash command starts.`,
      'Keep it there: reach elsewhere with absolute paths rather than cd, unless the developer asks you to move.',
    ].join(' ')
  }
}

@injectable()
export class RelativePathsFragment extends PromptFragment {
  readonly id = 'environment.relative-paths'

  text(): string {
    return [
      'A path you pass to a tool resolves against the project directory, so write those relative to it.',
      'A path inside a bash command is resolved by the shell instead, so write those absolute.',
    ].join(' ')
  }
}
