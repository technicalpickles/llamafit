import type { Detection, LocalModels, ModelInfo, LoadedModel, GenerateResult } from '../types.js';

export interface Backend {
  id: string;
  displayName: string;
  detect(): Promise<Detection>;
  localModels(): Promise<LocalModels>;
  /** Resolves null on timeout — a meaningful result, not an error. */
  generate(model: string, prompt: string, timeoutMs?: number): Promise<GenerateResult | null>;
  // Optional capabilities — absent method = backend can't do it; callers degrade and say so.
  remoteCandidates?(query?: string): Promise<ModelInfo[]>;
  loadedModels?(): Promise<LoadedModel[]>;
  pull?(model: string): Promise<void>;
  unload?(model: string): Promise<void>;
}
