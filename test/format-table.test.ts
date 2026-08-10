import { describe, it, expect } from 'vitest';
import { padCell, columnWidths, formatRow } from '../src/format/table.js';

describe('columnWidths', () => {
  it('takes the widest cell per column', () => {
    expect(
      columnWidths([['MODEL', 'Q'], ['gemma3:12b', 'Q4_K_M'], ['a', 'b']])
    ).toEqual([10, 6]);
  });

  it('handles a single row', () => {
    expect(columnWidths([['MODEL', 'QUANT']])).toEqual([5, 5]);
  });

  it('returns no widths for no rows', () => {
    expect(columnWidths([])).toEqual([]);
  });
});

describe('padCell', () => {
  it('pads to the target width', () => {
    expect(padCell('abc', 'abc', 5)).toBe('abc  ');
  });

  it('pads against the plain width, not the display width', () => {
    // A colorized cell carries invisible escape codes; padding against its own
    // length would over-pad and throw the column out of alignment.
    const display = '[32mok[0m';
    expect(padCell(display, 'ok', 4)).toBe(`${display}  `);
  });

  it('never returns a negative pad', () => {
    expect(padCell('toolong', 'toolong', 2)).toBe('toolong');
  });
});

describe('formatRow', () => {
  it('joins padded cells with two spaces', () => {
    expect(formatRow(['a', 'b'], ['a', 'b'], [3, 1])).toBe('a    b');
  });
});
