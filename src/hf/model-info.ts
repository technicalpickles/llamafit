import type { ModelInfo } from '../types.js';
import type { HfCandidate } from './discovery.js';

/** Shared HF candidate → ModelInfo mapping. Per the remote-candidates spec,
 * only the pull-name shape is per-backend: llama-server uses the bare repoId,
 * ollama uses `hf.co/<repoId>`. */
export function hfCandidatesToModelInfo(
  candidates: HfCandidate[],
  toName: (c: HfCandidate) => string
): ModelInfo[] {
  return candidates.map((c) => ({
    name: toName(c),
    source: 'remote',
    url: c.url,
    parameterSizeB: c.parameterSizeB,
    // Repos ship many quants; no single quant describes the repo. The
    // estimator's fallback covers the estimate, availableQuants covers pulling.
    quantizationLevel: null,
    diskSizeBytes: null,
    author: c.author,
    availableQuants: c.availableQuants,
    signals: c.signals,
    discoverySource: 'huggingface',
  }));
}
