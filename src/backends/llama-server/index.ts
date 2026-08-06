/** llama-server reports quantization as the human string from llama.cpp's
 * llama_ftype_name() (src/llama-model-loader.cpp). This maps each known string
 * to the canonical id form data/quants.json uses. Exact-string map rather than
 * a " - Medium"→"_M" parsing rule because the rendering isn't mechanical:
 * "Q2_K - Medium" is enum LLAMA_FTYPE_MOSTLY_Q2_K (no suffix) and
 * "IQ3_S mix - 3.66 bpw" is enum LLAMA_FTYPE_MOSTLY_IQ3_M. */
const FTYPE_TO_QUANT: Record<string, string> = {
  'all F32': 'F32',
  F16: 'F16',
  BF16: 'BF16',
  Q1_0: 'Q1_0',
  Q2_0: 'Q2_0',
  Q4_0: 'Q4_0',
  Q4_1: 'Q4_1',
  Q5_0: 'Q5_0',
  Q5_1: 'Q5_1',
  Q8_0: 'Q8_0',
  'MXFP4 MoE': 'MXFP4',
  NVFP4: 'NVFP4',
  'Q2_K - Medium': 'Q2_K',
  'Q2_K - Small': 'Q2_K_S',
  'Q3_K - Small': 'Q3_K_S',
  'Q3_K - Medium': 'Q3_K_M',
  'Q3_K - Large': 'Q3_K_L',
  'Q4_K - Small': 'Q4_K_S',
  'Q4_K - Medium': 'Q4_K_M',
  'Q5_K - Small': 'Q5_K_S',
  'Q5_K - Medium': 'Q5_K_M',
  Q6_K: 'Q6_K',
  'TQ1_0 - 1.69 bpw ternary': 'TQ1_0',
  'TQ2_0 - 2.06 bpw ternary': 'TQ2_0',
  'IQ2_XXS - 2.0625 bpw': 'IQ2_XXS',
  'IQ2_XS - 2.3125 bpw': 'IQ2_XS',
  'IQ2_S - 2.5 bpw': 'IQ2_S',
  'IQ2_M - 2.7 bpw': 'IQ2_M',
  'IQ3_XXS - 3.0625 bpw': 'IQ3_XXS',
  'IQ3_XS - 3.3 bpw': 'IQ3_XS',
  'IQ3_S - 3.4375 bpw': 'IQ3_S',
  'IQ3_S mix - 3.66 bpw': 'IQ3_M',
  'IQ1_S - 1.5625 bpw': 'IQ1_S',
  'IQ1_M - 1.75 bpw': 'IQ1_M',
  'IQ4_NL - 4.5 bpw': 'IQ4_NL',
  'IQ4_XS - 4.25 bpw': 'IQ4_XS',
};

const GUESSED_PREFIX = '(guessed) ';

/** Unknown strings pass through verbatim so lookupQuant (src/data.ts) flags
 * them as an unknown-quant gap instead of silently mis-normalizing. */
export function normalizeFtype(ftype: string): string {
  const stripped = ftype.startsWith(GUESSED_PREFIX) ? ftype.slice(GUESSED_PREFIX.length) : ftype;
  return FTYPE_TO_QUANT[stripped] ?? stripped;
}
