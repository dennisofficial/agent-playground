/**
 * The vocabulary a tool call is classified in, and a LEAF module: no imports, so the recognisers and
 * the registry can both reach it without a cycle.
 */

export enum EToolClass {
  /** Joins the run's sentence. `Read 3 files, searched 10 times, ran 6 commands`. */
  Gathered = 'gathered',
  /** Changed a file. Its own line, and its diff shows without being asked. */
  Change = 'change',
  /** A command worth naming. Its own line, in prose: `Pushed to origin/main`. */
  Command = 'command',
  /** A tool from outside Atlas, or one nobody has classified. Its own line. */
  External = 'external',
  /** The plan moved. Its own line, and the checklist under it. */
  Plan = 'plan',
}

/**
 * Which clause of the sentence a gathered call joins — NOT which tool it was.
 *
 * `sed -n '1,60p' file` is a read and `grep -rn pattern` is a search, however they were spelled. The
 * sentence is about what the agent DID, so the classification decides the clause and the tool's name
 * never reaches the reader.
 */
export enum EGather {
  Read = 'read',
  Recall = 'recall',
  Search = 'search',
  List = 'list',
  Run = 'run',
  Watch = 'watch',
  Browse = 'browse',
}

/** Which renderer an opened call gets. One per shape of output Atlas actually produces. */
export enum EDetail {
  None = 'none',
  Diff = 'diff',
  /** A file that was written whole — the diff's panel, without the diff's colours. */
  Created = 'created',
  /** A file that was read — numbered rows, syntax-highlighted under the path's filetype. */
  File = 'file',
  /** A picture that was read — for now its name, dimensions and weight on one line. */
  Image = 'image',
  Output = 'output',
  /** Why a call never ran, or why it came back an error — the sentence the model was handed. */
  Reason = 'reason',
  Matches = 'matches',
  Paths = 'paths',
  /** A page that was fetched — where it came from, and the opening of what came back. */
  Page = 'page',
  /** What a search turned up — a numbered list of titles over their urls. */
  Results = 'results',
  Plan = 'plan',
  Tests = 'tests',
}

export type Clause = {
  verb: string
  noun: [string, string]
  /** What its metric COUNTS, singular and plural. Null when it counts nothing worth totalling. */
  unit: [string, string] | null
}

export const CLAUSES: Record<EGather, Clause> = {
  [EGather.Read]: { verb: 'read', noun: ['file', 'files'], unit: ['line', 'lines'] },
  [EGather.Recall]: { verb: 'recalled', noun: ['memory', 'memories'], unit: null },
  [EGather.Search]: { verb: 'searched', noun: ['time', 'times'], unit: ['match', 'matches'] },
  [EGather.List]: { verb: 'listed', noun: ['directory', 'directories'], unit: null },
  [EGather.Run]: { verb: 'ran', noun: ['command', 'commands'], unit: null },
  [EGather.Watch]: { verb: 'checked', noun: ['shell', 'shells'], unit: null },
  [EGather.Browse]: { verb: 'browsed', noun: ['page', 'pages'], unit: null },
}

export type Classification = {
  klass: EToolClass
  /** The clause it contributes, when it joins the sentence. */
  gather: EGather | null
  /** What it is called in a LIST, where the column beside it already says what kind of thing it is. */
  line: string
  /**
   * What it is called standing ALONE, with no column to lean on.
   *
   * A list row can be a bare `src/ui/theme.ts` because `read` is printed next to it. A row on its own
   * beside `Typecheck clean` and `Wrote src/x.ts` cannot — it has to be a sentence too. Absent when
   * `line` is already one, which it is for every bash call, since the model wrote it.
   */
  alone?: string | undefined
  /**
   * Whether this call went wrong — which is NOT the same question as whether the tool errored.
   *
   * A `bash` call that returns exit 1 settled perfectly well; the command inside it failed. Only the
   * classification is in a position to tell those apart, so the sentence above and the colour beside
   * a row both ask here rather than asking the call.
   */
  failed: boolean
  /** The right-hand measure, in a few characters. */
  note: string
  /** The same measure as a number, so a sentence can add its calls up. */
  metric: number | null
  detail: EDetail
}
