import { createDarwinProbe } from './darwin.js';
import type { SystemProbe } from './types.js';

export function selectProbe(platform: string): SystemProbe | null {
  if (platform === 'darwin') return createDarwinProbe();
  return null;
}
