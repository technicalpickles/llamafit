export type Verdict = 'comfortable' | 'tight' | 'will-thrash';

export interface EstimateInput {
  parameterSizeB: number | null;
  quantizationLevel: string | null;
}

export interface HeadroomContext {
  baselineHeadroomGb: number;
  currentHeadroomGb: number;
}

export interface Estimate {
  footprintGb: number | null;
  quantKnown: boolean;
  quantUsedForEstimate: string | null;
  baselineVerdict: Verdict | 'unknown';
  currentVerdict: Verdict | 'unknown';
}

export interface Estimator {
  id: string;
  estimate(model: EstimateInput, headroom: HeadroomContext): Estimate;
}
