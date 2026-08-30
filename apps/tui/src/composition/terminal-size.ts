export type TerminalSize = {
  readonly width: number;
  readonly height: number;
};

export const SETTLE_DELAYS_MS: readonly number[] = [0, 60, 180, 500, 1200];

export function readTerminalSize(stdout: {
  columns?: number | undefined;
  rows?: number | undefined;
}): TerminalSize | null {
  const width = stdout.columns ?? 0;
  const height = stdout.rows ?? 0;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * `createCliRenderer` samples `stdout.columns` once and thereafter trusts SIGWINCH, so a window
 * resized between process spawn and the renderer's constructor leaves every panel a few columns
 * short until the operator resizes by hand. Re-reading the live winsize closes that gap.
 */
export function settleTerminalSize(args: {
  read: () => TerminalSize | null;
  current: () => TerminalSize;
  apply: (size: TerminalSize) => void;
  schedule: (run: () => void, delayMs: number) => () => void;
  delaysMs?: readonly number[];
}): () => void {
  const check = (): void => {
    const live = args.read();
    if (live === null) return;

    const sampled = args.current();
    if (live.width === sampled.width && live.height === sampled.height) return;

    args.apply(live);
  };

  const cancels = (args.delaysMs ?? SETTLE_DELAYS_MS).map((delayMs) =>
    args.schedule(check, delayMs),
  );

  return () => {
    for (const cancel of cancels) cancel();
  };
}
