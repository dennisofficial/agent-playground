import type { CliRenderer } from "@opentui/core";

export function copyToClipboard(renderer: CliRenderer, text: string): boolean {
  if (renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text))
    return true;
  if (process.platform !== "darwin") return false;

  try {
    // Synchronous: a copy that reports success before the write lands would show "copied" over a
    // clipboard that still holds the old text.
    const result = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
