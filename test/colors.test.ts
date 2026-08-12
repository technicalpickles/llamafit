import { describe, it, expect } from 'vitest';
import { shouldUseColor, colorizeBenchStatus } from '../src/colors.js';

describe('shouldUseColor', () => {
  it('is off when not a TTY (piped output), even with no other signal', () => {
    expect(shouldUseColor({ isTTY: false, env: {} })).toBe(false);
  });

  it('is on for a TTY with no overrides', () => {
    expect(shouldUseColor({ isTTY: true, env: {} })).toBe(true);
  });

  it('respects --no-color even on a TTY', () => {
    expect(shouldUseColor({ isTTY: true, env: {}, noColorFlag: true })).toBe(false);
  });

  it('respects the NO_COLOR convention even on a TTY', () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
  });

  it('respects FORCE_COLOR even when piped', () => {
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
  });
});

describe('colorizeBenchStatus', () => {
  it('prefixes a success symbol for completed', () => {
    expect(colorizeBenchStatus('completed', false)).toBe('✓ completed');
  });

  it('prefixes a failure symbol for timed-out', () => {
    expect(colorizeBenchStatus('timed-out', false)).toBe('✗ timed-out');
  });
});
