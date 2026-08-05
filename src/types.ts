export interface ModelInfo {
  name: string;
  source: 'local' | 'remote';
  url: string | null;
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  diskSizeBytes: number | null;
}

export interface SkippedModel {
  name: string;
  reason: string;
}

export interface LocalModels {
  models: ModelInfo[];
  skipped: SkippedModel[];
}

export interface LoadedModel {
  name: string;
  sizeVramGb: number;
  quantizationLevel: string | null;
}

export interface GenerateResult {
  evalCount: number | null;
  evalDurationSeconds: number | null;
  loadDurationSeconds: number | null;
  totalDurationSeconds: number | null;
}

export interface Detection {
  detected: boolean;
  version: string | null;
  evidence: Record<string, unknown>;
}
