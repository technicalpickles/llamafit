# llamafit

## Commands

- `npm test` — vitest, full suite
- `npm run typecheck` — typechecks test files (tsconfig.test.json); `npm run build` (plain `tsc`) typechecks src against tsconfig.json. Run both — they're separate configs, a green one doesn't imply the other is green.
- `npm run dev -- <args>` — run the CLI via tsx, e.g. `npm run dev -- check --query gemma`

## Verification

Real `ollama` and a real `llama-server` (router mode) run locally on this machine — use them. Don't stop at a unit test on the function you changed:

- A test that asserts your code against a fixture you wrote yourself (e.g. an invented Ollama CLI error string) proves nothing about reality. Run the real binary at least once and confirm the actual text before trusting a test built around it.
- A fix to CLI-facing output (a hint, an error message, a suggested next command) needs the suggested next step actually performed end-to-end, not just the rendering function called in isolation. The bug is often in the seam between two pieces — e.g. `check`'s bench hint not naming which backend to use, so copy-pasting it into `bench` let autodetection silently pick the wrong one — which no test of either function alone would catch.
- The command sandbox blocks `ollama`, `top`, SSH pushes, and other things this project's live verification needs. Retry with `dangerouslyDisableSandbox: true` rather than declaring something unverifiable — it usually works here.
- If genuinely unable to verify live, say so explicitly instead of asserting confidence from unit tests alone.

## Testing conventions

- TDD: write the failing test first, watch it fail for the right reason, then implement. See `superpowers:test-driven-development`.
- `test/helpers/fixture-backend.ts`'s `fixtureBackend()`/`fixtureProbe()` back most CLI/check/bench tests — override individual capabilities per test rather than hand-rolling a new fake backend.
- `test/output-guardrail.test.ts` snapshots are meant to catch *unintentional* drift, not to freeze behavior — update the fixture with `npx vitest run test/output-guardrail.test.ts -u` when an output change is deliberate.
- Injectable exec/fetch seams (see `src/probes/darwin.ts`'s `Exec` type, `src/backends/ollama/client.ts`'s `createPullModel`) are the pattern for testing code that shells out or hits a real service — default to the real implementation, accept an override for tests.
