export interface ModelInfo {
  name: string;
  source: 'local' | 'remote';
  url: string | null;
  parameterSizeB: number | null;
  quantizationLevel: string | null;
  diskSizeBytes: number | null;
  // Remote-discovery metadata. Optional: local rows and backends without
  // signal support leave them unset, which also keeps their JSON output
  // byte-identical (JSON.stringify omits absent keys).
  author?: string | null;
  availableQuants?: string[];
  signals?: RemoteSignals | null;
}

export interface RemoteSignals {
  downloads: number | null;
  likes: number | null;
  trendingScore: number | null;
  lastModified: string | null;
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
