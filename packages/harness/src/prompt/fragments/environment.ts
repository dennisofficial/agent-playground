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
      `The project directory is ${this.root}, and a relative path you pass to a tool resolves against it.`,
      'A bash command starts in the session directory instead, which cd moves and the conversation keeps telling you.',
    ].join(' ')
  }
}

@injectable()
export class RelativePathsFragment extends PromptFragment {
  readonly id = 'environment.relative-paths'

  text(): string {
    return [
      'Write tool paths relative to the project directory.',
      'They mean the same file wherever bash has moved, so never open a command with cd to reach a directory you are already in.',
    ].join(' ')
  }
}
