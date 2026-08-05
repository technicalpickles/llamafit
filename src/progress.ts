export interface Spinner {
  stop(finalMessage?: string): void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 120;

export interface SpinnerOptions {
  isTTY?: boolean;
  stream?: NodeJS.WritableStream;
}

/** Bench's pull/generate steps can each run for tens of seconds with nothing else to
 * report, so silence during them reads as a hang. On a real terminal this animates in
 * place; on a piped/redirected stream (no isTTY) overwriting a line makes no sense, so
 * it just prints the message once and prints the final message (if any) on its own line. */
export function startSpinner(message: string, opts: SpinnerOptions = {}): Spinner {
  const stream = opts.stream ?? process.stderr;
  const isTTY = opts.isTTY ?? !!(stream as NodeJS.WriteStream).isTTY;

  if (!isTTY) {
    stream.write(`${message}\n`);
    return {
      stop(finalMessage) {
        if (finalMessage) stream.write(`${finalMessage}\n`);
      },
    };
  }

  let frame = 0;
  const start = Date.now();
  const render = () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    stream.write(`\r${FRAMES[frame++ % FRAMES.length]} ${message} (${elapsed}s)`);
  };
  render();
  const timer = setInterval(render, TICK_MS);

  return {
    stop(finalMessage) {
      clearInterval(timer);
      stream.write('\r\x1b[K');
      if (finalMessage) stream.write(`${finalMessage}\n`);
    },
  };
}
