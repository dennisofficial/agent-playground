/**
 * Terminal output, made safe to put in a cell.
 *
 * A tool's output is bytes a terminal was meant to INTERPRET, not text. OpenTUI's buffer holds one
 * character per cell and interprets nothing, so an escape sequence that arrives intact is stored as
 * its literal bytes: `ESC`, `[`, `3`, `2`, `m` each take a column the renderer believes is occupied.
 * The real terminal then consumes those five bytes as a colour change costing zero columns, so every
 * character after them lands columns to the left of where the renderer thinks it is — and because the
 * renderer only repaints cells it believes changed, that drift is never repaired. What the reader
 * sees is fragments of one line smeared across the rows around it, surviving scroll.
 *
 * So the boundary where engine bytes become domain text is the place to flatten them: once, for
 * everything downstream — transcript, persisted message, and the copy a user takes out.
 */

/**
 * CSI (`ESC [ … m`), OSC (`ESC ] … BEL`/`ST`), charset designators (`ESC ( B`), and the plain
 * two-character escapes.
 */
const ESCAPES =
  /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -\/]+[0-~]|[@-Z\\-_])/g;

/** Everything C0 except tab and newline — a cell buffer already handles those two. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip escape sequences and control bytes, and resolve carriage returns the way a terminal would.
 *
 * `\r` is not noise to delete: a progress bar redraws itself by returning to column zero and writing
 * over what it wrote, so `50%\r100%` means `100%`. Deleting the `\r` would leave `50%100%` — a line
 * that never existed on any screen. Keeping only what follows the last one is what the user watched.
 */
export function stripTerminalControls(text: string): string {
  return text
    .replace(ESCAPES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const restart = line.lastIndexOf('\r');
      return restart === -1 ? line : line.slice(restart + 1);
    })
    .join('\n')
    .replace(CONTROLS, '');
}
