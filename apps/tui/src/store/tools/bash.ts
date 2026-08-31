/**
 * What a shell command actually DID.
 *
 * A run of `bash` calls is the least informative thing a transcript can say, because `bash` is not
 * one tool — it is every tool. So each command is read before it is counted: the ones that are
 * really reads join the read clause, the ones that are really searches join the search clause, and
 * the handful worth naming get a sentence of their own.
 *
 * Ordered: the first matcher that fires wins, so the specific ones come before the general.
 */

import { EDetail, EGather, EToolClass, type Classification } from './kinds'

export type Shell = {
  command: string
  /**
   * What the MODEL said the command does.
   *
   * The bash tool asks for it on every call and it is the one field in the payload written to be
   * read — `Rename wide to roomy and typecheck` beats `cd … && python3 - <<'PY'` in every row it
   * ever appears in.
   */
  description: string
  stdout: string
  exitCode: number | null
  ok: boolean
}

/**
 * A shell line exits with the status of its LAST stage, while `readShell` reads the clause from the
 * EARLIEST recognised one. `grep -rn foo src | head -20; ls apps; cat missing.json` is a search that
 * found its matches and exits 1 because `cat` did not.
 *
 * So a gathered clause may only trust the exit code when the line held a single stage. Across 30
 * real threads every gathered call marked failed was a multi-stage line whose command had worked;
 * the status belonged to somebody else's stage. A named command keeps trusting it either way —
 * reading that code is the whole reason those matchers exist.
 */
type Staged = Shell & { ownsExit: boolean }

type Matcher = {
  when: RegExp
  read: (shell: Staged) => Classification
}

const lines = (text: string): number => (text.length === 0 ? 0 : text.trim().split('\n').length)

const count = (value: number): string => value.toLocaleString('en-US')

const gathered = (args: {
  gather: EGather
  shell: Staged
  detail?: EDetail
  /** Whether this clause's metric is worth TOTALLING. The note is drawn either way. */
  counts?: boolean
}): Classification => {
  const printed = lines(args.shell.stdout)
  const broke = args.shell.ownsExit && !args.shell.ok

  return {
    klass: EToolClass.Gathered,
    gather: args.gather,
    line: said(args.shell),
    failed: broke,
    note: broke ? `exit ${args.shell.exitCode ?? 1}` : printed > 0 ? `${count(printed)} l` : '',
    metric: broke || args.counts === false ? null : printed,
    detail: args.detail ?? EDetail.Output,
  }
}

const said = (shell: Shell): string =>
  shell.description.length > 0 ? shell.description : firstLine(shell.command)

const named = (args: {
  line: string
  note: string
  failed: boolean
  detail?: EDetail
}): Classification => ({
  klass: EToolClass.Command,
  gather: null,
  line: args.line,
  failed: args.failed,
  note: args.note,
  metric: null,
  detail: args.detail ?? EDetail.Output,
})

export const firstLine = (command: string): string => command.split('\n')[0]?.trim() ?? command

/** `cd … && real command` — the prefix is where the agent stood, not what it did. */
export const withoutCd = (command: string): string =>
  command.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '').trim()

const TEST_TALLY = /^\s*(\d+)\s+pass\b/m

const FAIL_TALLY = /^\s*(\d+)\s+fail\b/m

function testsRead(shell: Shell): Classification {
  const passed = Number.parseInt(TEST_TALLY.exec(shell.stdout)?.[1] ?? '', 10)
  const failed = Number.parseInt(FAIL_TALLY.exec(shell.stdout)?.[1] ?? '', 10)

  // No tally to read — a detached run, or output the grep never reached. The model's own description
  // of the command beats a generic sentence about it.
  if (!Number.isInteger(passed)) {
    return named({
      line: said(shell),
      failed: !shell.ok,
      note: shell.ok ? 'done' : 'failed',
      detail: EDetail.Tests,
    })
  }

  const broke = Number.isInteger(failed) && failed > 0
  return {
    klass: EToolClass.Command,
    gather: null,
    line: broke
      ? `Tests — ${count(passed)} pass, ${count(failed)} fail`
      : `Tests — ${count(passed)} pass`,
    failed: broke,
    note: broke ? 'failed' : 'green',
    metric: null,
    detail: EDetail.Tests,
  }
}

const TS_ERROR = /error TS\d+/g

function typecheckRead(shell: Shell): Classification {
  const errors = shell.stdout.match(TS_ERROR)?.length ?? 0
  if (shell.ok && errors === 0) {
    return named({ line: 'Typecheck clean', note: 'green', failed: false })
  }
  return named({
    line: `Typecheck — ${count(errors)} ${errors === 1 ? 'error' : 'errors'}`,
    note: 'failed',
    failed: true,
  })
}

const branchOf = (command: string): string => {
  const explicit = /git\s+push\s+(\S+)\s+(\S+)/.exec(command)
  if (explicit !== null) return `${explicit[1]}/${explicit[2]}`
  return 'the remote'
}

const subjectOf = (command: string): string =>
  /-m\s+(?:'([^']*)'|"([^"]*)")/.exec(command)?.[1] ??
  /-m\s+(?:'([^']*)'|"([^"]*)")/.exec(command)?.[2] ??
  'a change'

const MATCHERS: readonly Matcher[] = [
  { when: /^git\s+push\b/, read: (shell) => named({ line: `Pushed to ${branchOf(shell.command)}`, note: shell.ok ? 'pushed' : 'failed', failed: !shell.ok }) },
  { when: /^git\s+commit\b/, read: (shell) => named({ line: `Committed “${subjectOf(shell.command)}”`, note: shell.ok ? 'committed' : 'failed', failed: !shell.ok }) },
  { when: /^git\s+add\b/, read: (shell) => named({ line: 'Staged the changes', note: shell.ok ? 'staged' : 'failed', failed: !shell.ok }) },
  { when: /^git\s+(status|diff|log|show)\b/, read: (shell) => gathered({ gather: EGather.Read, shell }) },
  { when: /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/, read: testsRead },
  { when: /\b(tsc|typecheck)\b/, read: typecheckRead },
  { when: /^(rm|mv|cp|mkdir|chmod|touch)\b/, read: (shell) => named({ line: said(shell), note: shell.ok ? 'done' : 'failed', failed: !shell.ok, detail: EDetail.None }) },
  { when: /^(sleep|timeout)\b/, read: (shell) => gathered({ gather: EGather.Run, shell, counts: false }) },
  { when: /^(sed\s+-n|cat|head|tail|wc)\b/, read: (shell) => gathered({ gather: EGather.Read, shell }) },
  { when: /^(grep|rg|ugrep|ack)\b/, read: (shell) => gathered({ gather: EGather.Search, shell }) },
  { when: /^(ls|find|tree)\b/, read: (shell) => gathered({ gather: EGather.List, shell, counts: false }) },
]

/**
 * A shell line is rarely one command. `echo "=== x ===" && grep -rn … | head -40` is a SEARCH with
 * scaffolding either side of it, and matching only the first word calls it a `run`.
 *
 * Stage first, then matchers: the EARLIEST recognised stage wins, because that is the one the rest of
 * the line is feeding. Scanning matcher-first instead let a trailing `wc -l` outrank a leading `ls`
 * and call a directory listing a read.
 */
const stagesOf = (command: string): string[] =>
  command
    .split(/&&|\|\||\||;/)
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0)

export function readShell(shell: Shell): Classification {
  const command = withoutCd(shell.command)
  const stages = stagesOf(firstLine(command))
  const staged: Staged = { ...shell, command, ownsExit: stages.length <= 1 }

  for (const stage of stages) {
    const matcher = MATCHERS.find((candidate) => candidate.when.test(stage))
    if (matcher !== undefined) return matcher.read(staged)
  }

  return gathered({ gather: EGather.Run, shell: staged, counts: false })
}
