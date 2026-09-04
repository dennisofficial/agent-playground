import { readIdling } from '@dltech/atlas-core'

import { MATCHED_LINES_CAP } from '../../shells/shell-watch'

export function bashDescription({
  defaultTimeoutMs,
  maximumTimeoutMs,
  defaultCheckInMs,
}: {
  defaultTimeoutMs: number
  maximumTimeoutMs: number
  defaultCheckInMs: number
}): string {
  return [
    'Run a command in bash.',
    'Every call starts in the project directory.',
    'To run somewhere else, pass that directory as workdir rather than opening the command with a cd - a cd moves only the process that runs it, and that process ends with the call.',
    'A relative workdir resolves against the project directory.',
    'Good: workdir "packages/core" with command "bun test". Bad: command "cd packages/core && bun test".',
    'Nothing carries between calls: the process is new each time, so a shell variable, function, background job or cd dies with the call that made it.',
    'stdout and stderr come back as one string, all of stdout first and then all of stderr, so the two are not interleaved.',
    'Only the tail is kept once the output grows past its cap.',
    'A non-zero exit is reported rather than raised, with the code named at the end.',
    `Times out after ${defaultTimeoutMs} ms unless timeoutMs says otherwise, and never later than ${maximumTimeoutMs} ms.`,
    'Every call carries a description: a few imperative words naming the job - Run the core tests, Rebase onto main - which is what the developer reads in place of the command.',
    'A command that waits by sleeping is refused, a poll loop included: idling advances nothing, so start the slow thing with runInBackground, or use the blocking wait its own tool already has - gh run watch --exit-status, gh pr checks --watch - rather than a loop around a status query.',
    'Set runInBackground to start a long-running command - a watch, a slow test suite - and get a shell id back at once instead of waiting.',
    'A dev server or anything else that should stay up while you keep working is not a background shell: it belongs on service_start, which never times out and never holds the turn open.',
    'A background shell starts in the same directory workdir names, interleaves stdout and stderr in arrival order, and outlives the turn that started it.',
    'It also survives an interrupt: stopping a turn stops the turn, not the shell, so nothing needs nohup, setsid, a detached subprocess or a sentinel file to stay alive - only shell_kill and the end of the session stop one.',
    'Its ending wakes you wherever you are, however it ends, carrying everything it printed - whether or not a turn is running when it lands.',
    'Its stdin is closed, so a command that stops to ask something can never be answered and will never end; that too is delivered to you, so a prompt is reported rather than waited out.',
    'timeoutMs on a background shell is a ceiling rather than a wait: the shell is killed if it outlives it, that killing reaches you as an ending like any other, and a background ceiling is not held to the foreground cap.',
    `checkInMs paces the check-ins of a background shell: every checkInMs ms that it is still running you are woken with how long it has been up, when it last printed, and its latest output, so a shell that neither ends nor reports is never waited on indefinitely - the default is ${defaultCheckInMs} ms, a check-in kills nothing, and output never postpones one, since a poll loop printing a line a minute is exactly the shell nobody is watching.`,
    'watch takes a regular expression, tested against every line the shell prints, and hands you the matching lines as they arrive instead of only at the end; it requires runInBackground.',
    'Match what would end the wait either way, not only the ending you are hoping for: a watch set to the success marker alone stays silent through a crash, and silence from a watch is indistinguishable from progress.',
    'So widen the alternation rather than narrow it - completed|ERROR|Traceback|FAILED|panic|Killed - and a failure wakes you as fast as a pass does.',
    'Matching lines arrive batched, and they never move the shell_output cursor: a read does not consume a pending match, and a match does not consume what a read would have returned.',
    `After ${MATCHED_LINES_CAP} matched lines the watch disarms and says so; the shell keeps running and still delivers its ending.`,
    'So never wait on one: no sleeping, no polling, no idle loop. Move on to other work, or end the turn and be woken.',
    'shell_output reads a shell that will not end on its own, shell_list shows what is running, and shell_kill stops one.',
  ].join(' ')
}

export function watchClause({ watch }: { watch: string | undefined }): readonly string[] {
  if (watch === undefined) return []

  return [
    `Lines matching ${watch} reach you as they are printed, batched rather than one by one, and after`,
    `${MATCHED_LINES_CAP} of them the watch disarms and says so while the shell carries on.`,
    'A match neither consumes nor is consumed by shell_output.',
  ]
}

export function ceilingClause({ timeoutMs }: { timeoutMs: number | undefined }): readonly string[] {
  if (timeoutMs === undefined) return []

  return [`It is killed if it outlives ${timeoutMs} ms, and the killing reaches you as its ending.`]
}

export function checkInClause({ checkInMs }: { checkInMs: number }): readonly string[] {
  return [
    `While it runs, a check-in reaches you every ${checkInMs} ms with how long it has been up and its latest output,`,
    'so it can never sit running unnoticed - if that cadence would only nag, it belongs on service_start.',
  ]
}

const NATIVE_WAITS = 'gh run watch --exit-status, gh pr checks --watch'

export function idlingRefusal(args: { command: string; timeoutMs: number }): string {
  const idle = readIdling(args)
  if (idle.unbounded) {
    return `this loop has no end: it polls until the ${args.timeoutMs} ms timeout kills the turn, and nothing it could learn arrives sooner for the waiting. Start this exact command with runInBackground - give it a watch naming both the outcome you want and the failures that would end the wait, and timeoutMs as a ceiling - or drop the loop for the blocking wait the underlying tool already has: ${NATIVE_WAITS}`
  }

  const across = idle.iterations === undefined ? '' : ` across ${idle.iterations} iterations`
  return `this command spends ${idle.seconds} seconds asleep${across}, and nothing advances while it does. Start this exact command with runInBackground, whose ending is delivered to you wherever you are and which takes a watch to tell you about a matching line before then, or drop the poll for the blocking wait the underlying tool already has: ${NATIVE_WAITS}`
}
