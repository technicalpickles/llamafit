import type { Detection, LocalModels, ModelInfo, LoadedModel, GenerateResult } from '../types.js';

/** Aggregated download progress across all files a pull is fetching in parallel. */
export interface PullProgress {
  doneBytes: number;
  totalBytes: number;
}

export interface RemoteCandidateOptions {
  /** Server-side size filter — candidates above this are never fetched. */
  maxParameterSizeB?: number;
}

export interface Backend {
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  localModels(): Promise<LocalModels>;
  /** Resolves null on timeout — a meaningful result, not an error. */
  generate(model: string, prompt: string, timeoutMs?: number): Promise<GenerateResult | null>;
  // Optional capabilities — absent method = backend can't do it; callers degrade and say so.
  remoteCandidates?(query?: string, opts?: RemoteCandidateOptions): Promise<ModelInfo[]>;
  loadedModels?(): Promise<LoadedModel[]>;
  /** onProgress is best-effort UI plumbing: it may never fire (a download can
   * complete before any progress event), and implementations need not guard
   * against it throwing. */
  pull?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
  unload?(model: string): Promise<void>;
}
