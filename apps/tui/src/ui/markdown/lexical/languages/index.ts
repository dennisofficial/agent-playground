import type { LanguageSpec } from '../spec'
import { ada } from './ada'
import { asm } from './asm'
import { autohotkey } from './autohotkey'
import { cSharp } from './c_sharp'
import { clojure } from './clojure'
import { cobol } from './cobol'
import { commonlisp } from './commonlisp'
import { crystal } from './crystal'
import { d } from './d'
import { dart } from './dart'
import { delphi } from './delphi'
import { elixir } from './elixir'
import { erlang } from './erlang'
import { forth } from './forth'
import { fortran } from './fortran'
import { fsharp } from './fsharp'
import { graphql } from './graphql'
import { groovy } from './groovy'
import { haskell } from './haskell'
import { icon } from './icon'
import { julia } from './julia'
import { kotlin } from './kotlin'
import { less } from './less'
import { matlab } from './matlab'
import { nim } from './nim'
import { objc } from './objc'
import { ocaml } from './ocaml'
import { pascal } from './pascal'
import { perl } from './perl'
import { powershell } from './powershell'
import { prolog } from './prolog'
import { r } from './r'
import { racket } from './racket'
import { rebol } from './rebol'
import { ruby } from './ruby'
import { sass } from './sass'
import { scala } from './scala'
import { scheme } from './scheme'
import { scss } from './scss'
import { smalltalk } from './smalltalk'
import { swift } from './swift'
import { tcl } from './tcl'
import { vbnet } from './vbnet'
import { verilog } from './verilog'
import { vhdl } from './vhdl'
import { vim } from './vim'
import { xml } from './xml'

// An explicit list, not a directory scan: `bun build --compile` only embeds a module it can see a
// static import for, so a scanned language would resolve in `bun dev` and vanish from the binary.
// `registry.spec.ts` fails if a file in this directory is missing from the array.

export const LEXICAL_LANGUAGES: readonly LanguageSpec[] = [
  ada,
  asm,
  autohotkey,
  cSharp,
  clojure,
  cobol,
  commonlisp,
  crystal,
  d,
  dart,
  delphi,
  elixir,
  erlang,
  forth,
  fortran,
  fsharp,
  graphql,
  groovy,
  haskell,
  icon,
  julia,
  kotlin,
  less,
  matlab,
  nim,
  objc,
  ocaml,
  pascal,
  perl,
  powershell,
  prolog,
  r,
  racket,
  rebol,
  ruby,
  sass,
  scala,
  scheme,
  scss,
  smalltalk,
  swift,
  tcl,
  vbnet,
  verilog,
  vhdl,
  vim,
  xml,
]
