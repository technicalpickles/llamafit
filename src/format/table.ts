/** Table layout primitives shared by the check renderer. Column widths are
 * computed from plain (uncolored) text and cells are padded against that plain
 * width — ANSI escape codes have no display width, so padding against a
 * colorized cell's own `.length` pads too far and breaks alignment. */

export function columnWidths(plainRows: string[][]): number[] {
  if (plainRows.length === 0) return [];
  const columns = Math.max(...plainRows.map((row) => row.length));
  return Array.from({ length: columns }, (_, i) =>
    Math.max(...plainRows.map((row) => (row[i] ?? '').length))
  );
}

export function padCell(display: string, plain: string, width: number): string {
  return display + ' '.repeat(Math.max(0, width - plain.length));
}

export function formatRow(
  displayCells: string[],
  plainCells: string[],
  widths: number[]
): string {
  return displayCells.map((c, i) => padCell(c, plainCells[i], widths[i])).join('  ');
}
