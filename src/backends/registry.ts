import { ollamaBackend } from './ollama/index.js';
import type { Backend } from './types.js';
import type { Detection } from '../types.js';

const BACKENDS: Backend[] = [ollamaBackend];

export function allBackends(): Backend[] {
  return [...BACKENDS];
}

export function findBackend(id: string): Backend | null {
  return BACKENDS.find((b) => b.id === id) ?? null;
}

export async function detectBackends(
  backends: Backend[] = BACKENDS
): Promise<Array<{ backend: Backend; detection: Detection }>> {
  const results = await Promise.all(backends.map(async (backend) => ({ backend, detection: await backend.detect() })));
  return results.filter((r) => r.detection.detected);
}
