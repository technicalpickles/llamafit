const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
} as const;

export const SYMBOLS = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: '→',
} as const;

export interface ShouldUseColorOptions {
  noColorFlag?: boolean;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Honors the --no-color flag, the NO_COLOR/FORCE_COLOR conventions, and TTY detection,
 * so piping `check --json` (or any output) into a file or another program never embeds
 * escape codes. */
export function shouldUseColor(opts: ShouldUseColorOptions = {}): boolean {
  const { noColorFlag = false, isTTY = process.stdout.isTTY, env = process.env } = opts;
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return !!isTTY;
}

function paint(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${CODES.reset}` : text;
}

/** A field label ("Model:", "Status:") — bold gives it visual weight without implying
 * status the way a semantic color would. */
export function label(text: string, enabled: boolean): string {
  return paint(CODES.bold, text, enabled);
}

/** Secondary/metadata text (e.g. a link under a value) that shouldn't compete with the
 * primary line above it. */
export function dim(text: string, enabled: boolean): string {
  return paint(CODES.dim, text, enabled);
}

export function colorizeBenchStatus(status: string, enabled: boolean): string {
  const symbol = status === 'completed' ? SYMBOLS.success : SYMBOLS.error;
  const code = status === 'completed' ? CODES.green : CODES.red;
  return `${paint(code, symbol, enabled)} ${status}`;
}

export function info(message: string, enabled: boolean): string {
  return `${paint(CODES.blue, SYMBOLS.info, enabled)} ${message}`;
}

export function success(message: string, enabled: boolean): string {
  return `${paint(CODES.green, SYMBOLS.success, enabled)} ${message}`;
}

export function warn(message: string, enabled: boolean): string {
  return `${paint(CODES.yellow, SYMBOLS.warning, enabled)} ${message}`;
}

export function error(message: string, enabled: boolean): string {
  return `${paint(CODES.red, SYMBOLS.error, enabled)} ${message}`;
}
