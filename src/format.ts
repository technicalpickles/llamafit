/** Barrel kept so import sites outside src/format/ are unaffected by the split. */
export { formatCheckTable, formatCheckJson } from './format/check.js';
export { formatBenchResult, formatPullProgress } from './format/bench.js';
export type { FormatOptions } from './format/bench.js';
