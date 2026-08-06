import { writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Gap } from './gaps.js';

export interface DiagnosticsInput {
  version: string;
  platform: { platform: string; release: string; arch: string };
  gaps: Gap[];
  probeEvidence: Record<string, string> | null;
}
export interface WriteOptions { dir?: string; now?: Date }

export function buildBundle(input: DiagnosticsInput): string {
  let text = JSON.stringify(input, null, 2);
  text = text.split(homedir()).join('~');
  const host = hostname();
  if (host.length > 0) text = text.split(host).join('<host>');
  return text;
}

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function writeDiagnosticsBundle(input: DiagnosticsInput, opts: WriteOptions = {}): string {
  const path = resolve(join(opts.dir ?? process.cwd(), `llamafit-diagnostics-${timestamp(opts.now ?? new Date())}.json`));
  writeFileSync(path, buildBundle(input));
  return path;
}
