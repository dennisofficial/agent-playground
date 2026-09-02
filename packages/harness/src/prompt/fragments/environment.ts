import { PromptFragment, type ClockPort, type PromptContext } from '@dltech/atlas-core'

import { SystemClock } from '../../store/clock'
import { localDayOf, localWeekdayOf } from '../../time/local-day'
import { VolatilePromptFragment } from '../volatile'

export class ProjectDirectoryFragment extends PromptFragment {
  readonly id = 'environment.project-directory'

  text(ctx: PromptContext): string {
    return [
      `The project directory is ${ctx.projectDirectory}, and every bash command starts there.`,
      'You are already in it, so never spend a cd returning to it, and run somewhere else by passing that directory as workdir rather than by cd.',
    ].join(' ')
  }
}

export class TodayFragment extends VolatilePromptFragment {
  readonly id = 'environment.today'

  private readonly clock: ClockPort = new SystemClock()

  stamp(): string {
    return localDayOf(this.clock.now())
  }

  text(): string {
    const instant = this.clock.now()
    const day = localDayOf(instant)
    if (day === '') return ''

    const weekday = localWeekdayOf(instant)
    return `Today is ${weekday === '' ? day : `${weekday}, ${day}`}.`
  }
}

export class RelativePathsFragment extends PromptFragment {
  readonly id = 'environment.relative-paths'

  text(): string {
    return [
      'A path you pass to a tool resolves against the project directory, so write those relative to it.',
      'A path inside a bash command is resolved by the shell instead, against workdir or the project directory, so write those absolute.',
    ].join(' ')
  }
}
