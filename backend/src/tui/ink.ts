/**
 * The Ink ESM shim. `ink` and `@inkjs/ui` are ESM-only; the backend compiles to CJS, and JSX needs
 * identifiers available at module scope — a DI token can't provide those. So this module re-exports
 * live bindings that `loadInk()` fills in via dynamic import (preserved under `module: nodenext`).
 * `main.ts` MUST await `loadInk()` before rendering — the bindings are `undefined` until then.
 * CJS consumers must access these as properties (`ink.render`), never destructure at require time.
 *
 * Type-only imports from 'ink' are erased at compile time and always safe.
 */
import type InkNamespace from 'ink';
import type UiNamespace from '@inkjs/ui';

type Ink = typeof InkNamespace;
type InkUi = typeof UiNamespace;

let loaded = false;

export let Box: Ink['Box'];
export let Text: Ink['Text'];
export let render: Ink['render'];
export let measureElement: Ink['measureElement'];
export let useApp: Ink['useApp'];
export let useInput: Ink['useInput'];
export let useWindowSize: Ink['useWindowSize'];
export let Spinner: InkUi['Spinner'];
export let TextInput: InkUi['TextInput'];

/** Load the ESM-only ink packages and fill the live bindings. Idempotent. */
export async function loadInk(): Promise<void> {
  if (loaded) return;
  const ink = await import('ink');
  const ui = await import('@inkjs/ui');
  Box = ink.Box;
  Text = ink.Text;
  render = ink.render;
  measureElement = ink.measureElement;
  useApp = ink.useApp;
  useInput = ink.useInput;
  useWindowSize = ink.useWindowSize;
  Spinner = ui.Spinner;
  TextInput = ui.TextInput;
  loaded = true;
}
