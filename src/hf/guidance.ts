/** Emitted as CheckResult.remoteGuidance whenever remote candidates carry
 * trust signals. The named orgs are examples illustrating the criteria, NOT
 * an allowlist — deliberate decision, see the spec's "no allowlist" bullet. */
export const REMOTE_GUIDANCE = `Remote candidates come from the Hugging Face Hub (trending, size-capped to this machine's headroom) and are NOT vetted. Qualify the source before pulling:
- Trustworthy: official model-vendor orgs (Qwen, meta-llama, google, microsoft, LiquidAI) and quant houses with a history across many model families (examples: ggml-org, bartowski, unsloth, lmstudio-community). A verified-org badge on the repo page is a good sign.
- Distrust: single-model orgs; names stuffed with "uncensored"/"abliterated"/merge word salad; download counts wildly out of proportion to likes and account age — download counts are botted in practice, never trust them alone.
Each candidate lists availableQuants; pull as <owner>/<repo>:<QUANT>.`;
