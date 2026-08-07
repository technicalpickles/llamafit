import { describe, it, expect, vi, afterEach } from 'vitest';
import { startSpinner } from '../src/progress.js';

function fakeStream() {
  const writes: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    writes,
  };
}

describe('startSpinner on a non-TTY stream (piped/redirected)', () => {
  it('prints the message once, since overwriting a line only makes sense on a real terminal', () => {
    const stream = fakeStream();
    const spinner = startSpinner('Pulling gemma3:12b...', { isTTY: false, stream });
    expect(stream.writes).toEqual(['Pulling gemma3:12b...\n']);
    spinner.stop();
    expect(stream.writes).toEqual(['Pulling gemma3:12b...\n']);
  });

  it('prints the final message on stop, if given', () => {
    const stream = fakeStream();
    const spinner = startSpinner('Pulling gemma3:12b...', { isTTY: false, stream });
    spinner.stop('✓ Pulled gemma3:12b (4.2s)');
    expect(stream.writes).toEqual(['Pulling gemma3:12b...\n', '✓ Pulled gemma3:12b (4.2s)\n']);
  });
});

describe('startSpinner on a TTY', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('animates on an interval and clears the line on stop', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const spinner = startSpinner('Generating...', { isTTY: true, stream });

    // Renders immediately, then again on each tick.
    expect(stream.writes.length).toBe(1);
    vi.advanceTimersByTime(120);
    expect(stream.writes.length).toBe(2);
    vi.advanceTimersByTime(120);
    expect(stream.writes.length).toBe(3);
    expect(stream.writes.every((w) => w.includes('Generating...'))).toBe(true);

    spinner.stop();
    const lineClear = stream.writes.at(-1)!;
    expect(lineClear).toBe('\r\x1b[K');

    // No more ticks after stop.
    const countAfterStop = stream.writes.length;
    vi.advanceTimersByTime(500);
    expect(stream.writes.length).toBe(countAfterStop);
  });
});

describe('spinner.update', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the new message on subsequent ticks on a TTY', () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const spinner = startSpinner('Pulling model...', { isTTY: true, stream });

    spinner.update('Pulling model... 1.2/2.7 GB (45%)');
    vi.advanceTimersByTime(120);
    expect(stream.writes.at(-1)).toContain('1.2/2.7 GB (45%)');

    spinner.stop();
  });

  it('is a no-op on a non-TTY stream', () => {
    const stream = fakeStream();
    const spinner = startSpinner('Pulling model...', { isTTY: false, stream });

    spinner.update('Pulling model... 1.2/2.7 GB (45%)');
    expect(stream.writes).toEqual(['Pulling model...\n']);

    spinner.stop();
  });
});
