import { genericHandler } from './handlers/generic';
import { mcpBridgeHandler } from './handlers/mcp-bridge';
import { nativeFileHandler } from './handlers/native-file';
import { nativeMiscHandler } from './handlers/native-misc';
import { nativeSearchHandler } from './handlers/native-search';
import { nativeShellHandler } from './handlers/native-shell';
import type { ToolHandler } from './types';

/**
 * The tool-renderer registry. Ordered most-specific → least: exact native tool names, then the Atlas
 * bridge prefix, then the catch-all generic handler LAST. `resolveHandler` returns the first match, so
 * a broad matcher can never shadow a specific one.
 *
 * To support a new tool family, add a {@link ToolHandler} module under `handlers/` and slot it in here
 * before `genericHandler`.
 */
export const HANDLERS: readonly ToolHandler[] = [
  nativeFileHandler,
  nativeShellHandler,
  nativeSearchHandler,
  nativeMiscHandler,
  mcpBridgeHandler,
  genericHandler,
];

export function resolveHandler(name: string, input: unknown): ToolHandler {
  return HANDLERS.find((h) => h.match(name, input)) ?? genericHandler;
}
