import { loadQuantTable, lookupQuant, loadCalibration, loadThresholds } from '../data.js';
import type { Estimator, Estimate, EstimateInput, HeadroomContext, Verdict } from './types.js';

export function classifyVerdict(footprintGb: number, headroomGb: number): Verdict {
  const { tightRatio, thrashRatio } = loadThresholds();
  if (footprintGb > headroomGb * thrashRatio) return 'will-thrash';
  if (footprintGb > headroomGb * tightRatio) return 'tight';
  return 'comfortable';
}

export const formulaEstimator: Estimator = {
  id: 'formula-v1',
  estimate(model: EstimateInput, headroom: HeadroomContext): Estimate {
    if (model.parameterSizeB === null) {
      return {
        footprintGb: null,
        quantKnown: false,
        quantUsedForEstimate: null,
        baselineVerdict: 'unknown',
        currentVerdict: 'unknown',
      };
    }
    const quant = lookupQuant(loadQuantTable(), model.quantizationLevel ?? '');
    const footprintGb = model.parameterSizeB * quant.bytesPerParam * loadCalibration().overheadMultiplier;
    return {
      footprintGb,
      quantKnown: quant.known,
      quantUsedForEstimate: quant.known ? (model.quantizationLevel as string) : quant.id,
      baselineVerdict: classifyVerdict(footprintGb, headroom.baselineHeadroomGb),
      currentVerdict: classifyVerdict(footprintGb, headroom.currentHeadroomGb),
    };
  },
};
