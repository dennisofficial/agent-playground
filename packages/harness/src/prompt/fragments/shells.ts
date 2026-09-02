import { PromptFragment } from '@dltech/atlas-core'


export class BackgroundShellsFragment extends PromptFragment {
  readonly id = 'shells.background'

  text(): string {
    return [
      'A command that will outlive the call that starts it — a dev server, a watcher, a long build —',
      'belongs in the background, through runInBackground. What it prints comes back to you on its',
      'own when it ends, wherever you are, and opens a turn of its own if nothing is running.',
      '',
      'So never wait for one by sleeping, and never poll it: shell_list and shell_output can tell you',
      'nothing about a finished shell that its ending will not tell you first. Ending your turn is how',
      'you wait. If you have work that does not depend on the shell, do that work instead; if you are',
      'only waiting, say what for and end the turn.',
    ].join('\n')
  }
}
