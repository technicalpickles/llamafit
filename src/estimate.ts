const BYTES_PER_PARAM: Record<string, number> = {
  F32: 4.0,
  FP32: 4.0,
  F16: 2.0,
  BF16: 2.0,
  FP16: 2.0,
  FP8: 1.0,
  Q8_0: 1.0,
  Q6_K: 0.75,
  Q5_K_M: 0.69,
  Q4_K_M: 0.5625,
  Q4_0: 0.5,
  MXFP4: 0.5,
  NVFP4: 0.5,
  Q3_K_M: 0.44,
  Q2_K: 0.35,
};

const FALLBACK_QUANT = 'Q4_K_M';

/** Calibrated against real session measurements — see spec's Memory Estimation Model table. */
export const OVERHEAD_MULTIPLIER = 1.25;

/** Fixed reserve for macOS + normal daily apps on a 24GB machine. Not configurable in v1. */
export const MACOS_BASELINE_RESERVE_GB = 8;

export function bytesPerParam(quantizationLevel: string): { value: number; known: boolean } {
  const key = quantizationLevel.trim().toUpperCase();
  if (key.length > 0 && key in BYTES_PER_PARAM) {
    return { value: BYTES_PER_PARAM[key], known: true };
  }
  return { value: BYTES_PER_PARAM[FALLBACK_QUANT], known: false };
}

export interface FootprintEstimate {
  weightsGb: number;
  estimatedFootprintGb: number;
  quantKnown: boolean;
  quantUsedForEstimate: string;
}

export function estimateFootprint(parameterSizeB: number, quantizationLevel: string): FootprintEstimate {
  const { value: bpp, known } = bytesPerParam(quantizationLevel);
  const weightsGb = parameterSizeB * bpp;
  return {
    weightsGb,
    estimatedFootprintGb: weightsGb * OVERHEAD_MULTIPLIER,
    quantKnown: known,
    quantUsedForEstimate: known ? quantizationLevel : FALLBACK_QUANT,
  };
}

export type Verdict = 'comfortable' | 'tight' | 'will-thrash';

export function classifyVerdict(footprintGb: number, headroomGb: number): Verdict {
  if (footprintGb > headroomGb * 0.95) return 'will-thrash';
  if (footprintGb > headroomGb * 0.7) return 'tight';
  return 'comfortable';
}
