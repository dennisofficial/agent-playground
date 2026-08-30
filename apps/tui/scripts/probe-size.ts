export {};

const ask = (
  query: string,
  match: RegExp,
  timeoutMs = 400,
): Promise<string | null> =>
  new Promise((resolve) => {
    let buffer = "";
    const done = (value: string | null) => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const hit = buffer.match(match);
      if (hit) done(hit[0]);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    process.stdin.on("data", onData);
    process.stdout.write(query);
  });

const kernel = () => `${process.stdout.columns}x${process.stdout.rows}`;

process.stdin.setRawMode(true);
process.stdin.resume();

const at0 = kernel();
const textArea = await ask("\x1b[18t", /\x1b\[8;\d+;\d+t/);
const windowPx = await ask("\x1b[14t", /\x1b\[4;\d+;\d+t/);
await new Promise((r) => setTimeout(r, 500));
const at500 = kernel();

process.stdin.setRawMode(false);
process.stdin.pause();

console.log(
  `TERM_PROGRAM   ${process.env.TERM_PROGRAM ?? "?"} ${process.env.TERM_PROGRAM_VERSION ?? ""}`,
);
console.log(`kernel @0ms    ${at0}`);
console.log(`kernel @500ms  ${at500}`);
console.log(
  `CSI 18t        ${textArea === null ? "(no reply)" : textArea.replace("\x1b", "ESC")}  <- emulator's own cols/rows`,
);
console.log(
  `CSI 14t        ${windowPx === null ? "(no reply)" : windowPx.replace("\x1b", "ESC")}  <- text area in pixels`,
);
