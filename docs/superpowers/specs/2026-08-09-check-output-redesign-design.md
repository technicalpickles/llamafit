# check output redesign — design

`llamafit check` prints 80 lines of stdout for 6 distinct local models. The
volume is a symptom: the command is answering two questions at once, and the
data feeding both is worse than the layout suggests. This spec fixes the data
first, then the presentation, because most of the volume disappears once the
inputs are correct.

Measured on this machine (24GB M-series, 2026-08-09), the current output is:

| Block | Lines | Content |
| --- | --- | --- |
| Table | 34 | 7 local rows (6 distinct) + 26 remote candidates |
| Legend | 2 | `~` and `?` explanations |
| Remote model links | 27 | re-lists all 26 remote names to attach a URL |
| Sources / guidance / cloud | 6 | provenance, 14 cloud model names |
| Headroom | 2 | the numbers every verdict above is relative to |
| Next hint | 1 | |
| Gap report (stderr) | ~12 | agent prompt + ~500-char issue URL |

## Decisions already made

From brainstorming with the user, in order:

1. Both jobs are first-class: "what should I run right now?" **and** "what
   should I go download?". Neither is noise; neither gets to dominate.
2. Candidate quality is fixed before layout. Layout work on a bad list is
   polishing the wrong thing.
3. Default output is ranked sections, capped, with `+N more` escape hatches.
4. Local models group by fit verdict, sorted by footprint descending inside
   each group.
5. **Cloud models are removed from rendered output.** They run elsewhere, so
   they have no fit question — including them in a tool that answers "does
   this fit *this machine*" is a category error.
6. **No size floor** on remote candidates. Rank and cap only; one less knob.
7. Hugging Face is the default remote source. The `ollama.com` scrape is
   retained for `--query` and `--remote` (justified under
   `drop-mlx-default` below).

## Evidence

Every claim below was verified live against this machine's `ollama` and the
real HF API on 2026-08-09, not against fixtures. This matters in both
directions: the `mlx` default survived three prior specs as "historical
default preserved" because nobody re-derived why it was there, and the first
draft of this spec then over-read the founding spec's note as condemning MLX
models outright. One `/api/show` call settled it.

**MLX-tagged community models are ordinary GGUFs and run fine.**
`cyborgxx101/gemma-4-12b-opus-finetuned-mlx:4bit` →
`format: gguf`, `family: gemma4`, `parameter_size: 11.9B`,
`quantization_level: Q4_K_M`. The tag is cosmetic. This is a reason the
default query is the wrong *mechanism*, not a reason to exclude these models.

**Ollama reports two different "no value" strings for quantization.**
`/api/tags` across 21 entries:

```
'Q4_K_M' 5   'unknown' 2   '' 4   'fp8' 5   'bf16' 4   'MXFP4' 1
```

`''` is already handled (falsy → `null` → the `?` path). `'unknown'` is not,
so it reaches the estimator as a quant name and raises an `unknown-quant`
gap. Every other value (`fp8`, `bf16`, `MXFP4`) is already aliased in
`data/quants.json` and belongs to a cloud model that is skipped before
estimation. **The only gap this machine can produce is that false positive.**

**Seven local rows are six models.** `hf.co/yuxinlu1/gemma-4-12B-agentic-…-GGUF`
appears as `:Q4_K_M` and `:latest`, both digest `036489398bf6`.

**The same model is offered as a remote candidate while already pulled — and
from both sources, not one.** `yuxinlu1/gemma-4-12B-agentic-…-GGUF` occupies
three rows of one table: two local tags plus one Hugging Face candidate.

**Corrected during implementation:** there is a second, independent case this
section originally missed. `cyborgxx101/gemma-4-12b-opus-finetuned-mlx` is
pulled locally as `:4bit` and *also* arrives from the `ollama.com` scrape — a
duplicate pair visible in the pre-redesign snapshot all along. Dedup therefore
has to match candidates from either source against local names, which it does
(it keys on the untagged name, not on provenance). Found because an implementer
verified a predicted per-source breakdown instead of accepting it: the totals
happened to agree while the attribution did not.

**`trendingScore` ranks badly for this purpose.** The HF API's own sort put
`SupraLabs/Supra2-100M-Instruct` (0.1B, 1,462 downloads) at position 4 and
`ornith-ai/Ornith-1.0-9B-GGUF` (**4,489,302 downloads**) at position 7.
Trending rewards novelty. `downloads` is already in the response payload.

**`availableQuants` is populated on every HF candidate** and nearly all
include `Q4_K_M`, yet `hfCandidatesToModelInfo` discards it and sets
`quantizationLevel: null`, so the estimator blind-guesses. The real quant
list is then printed at the bottom of the output in a separate block: the
links block carries better data than the table row it duplicates.

**`signals` (downloads/likes/trendingScore) is fetched and never used** for
ordering or display. It reaches `--json` only.

## Data-quality changes

Slugs are stable identifiers for commits and cross-references.

### `drop-mlx-default`

`src/backends/ollama/index.ts:102` sets `SCRAPE_DEFAULT_QUERY = 'mlx'`, which
produces 16 of the 26 remote rows.

**Not because MLX models are broken.** They are not. Verified live: the
locally-pulled `cyborgxx101/gemma-4-12b-opus-finetuned-mlx:4bit` reports
`format: gguf`, `Q4_K_M`, 11.9B, and classifies `comfortable`. It runs fine.
The founding spec's observation
(`2026-08-04-ollama-scope-cli-design.md:30`) is narrower than it first reads:
the `mlx` **tag** is cosmetic — community uploads carrying it are ordinary
GGUFs — and the ">32GB, out of reach" clause describes Ollama's *official*
MLX support, not these community models. Nor is the reason duplication; that
is `dedup-remote-against-local`, which fires on `yuxinlu1` and `cyborgxx101`
models alike regardless of the query.

The reason is structural: **a default query is a filter, and no-query should
not mean filtered.** `--query gemma` means "search for gemma"; omitting
`--query` should mean "show me what is relevant and fits," not "search for the
string `mlx`." Two consequences follow, neither about MLX:

- **Half the results cannot run here.** The tag selected four 35B models
  (~24.6GB) and three 27B models (~19.0GB) against a 16GB baseline budget —
  7 of 14 `will-thrash`. The scraper has no server-side size cap, unlike the
  HF source which honors `maxParameterSizeB`.
- **Searching a community tag selects for reuploaders**, not for quality.
  That is how `…-nvfp4-mlx-latest-latest-latest-latest-latest-latest` earns a
  row. An argument against tag-search as a discovery strategy, not against MLX.

Surfacing Mac-relevant models is a reasonable goal on this hardware; string
matching a community tag is the wrong mechanism for it, and by the founding
spec's own finding it does not even select genuine MLX models.

Delete the constant. Both sources default to `''` when no query is given,
matching llama-server. MLX-tagged models still appear whenever they are the
best-ranked candidates or when asked for by name via `--query mlx`.

Additionally, **the `ollama.com` scrape leaves the default path.** With an
empty query it returns 20 rows, of which: 10 carry no size at all, 4 exceed
the 22.7B cap `maxCandidateParamsB` computes for this machine
(`nemotron-3-super` 120B, `nemotron3` 33B, `lfm2` 24B, `qwen3.6` 27B), and
`ornith` duplicates HF's higher-signal copy. Three survive. Those three carry
no download signal and no quant data, so they cannot join a downloads-ranked,
real-quant list. The scraper stays wired up and is used whenever `--query` is
given (where flagship-name matching is its strength) and is shown by
`--remote`; it contributes nothing to a no-query run.

### `unknown-quant-sentinel`

Treat the literal string `'unknown'` from a backend's quantization field as
not-reported, identical to `''`. The row renders `?`, the estimator uses the
fallback, and **no gap is raised.**

This is a correctness fix, not a volume fix. `unknownQuantPrompt` currently
tells an agent to "add an entry or alias for it to `data/quants.json` with a
bytes-per-param value" — for the concept *unknown*. There is no correct
bytes-per-param for that, so the prompt invites a wrong number into the
estimator. This lands as its own commit ahead of the redesign.

The sentinel list lives next to the mapper as a named constant so a second
sentinel (some other backend's `"none"`, `"N/A"`) is a one-line addition.

### `quant-from-tag`

Ollama pulls HF repos as `hf.co/<owner>/<repo>:<quant>`, so the tag names the
quantization. When the backend reports no quant (including via
`unknown-quant-sentinel`) and the tag matches a known entry or alias in
`data/quants.json`, use it and set `quantKnown: true`.

Heuristic, but a cheap and well-bounded one: it only fires on names shaped
like `hf.co/…:<known-quant>`, and a tag that doesn't match a known quant
falls through to `?` unchanged. Turns `?` into a real quant for exactly the
models whose `'unknown'` string motivated the sentinel fix.

### `quant-from-available`

`src/hf/model-info.ts` sets `quantizationLevel: null` on every candidate.
Instead, pick the quant we would actually pull:

1. `Q4_K_M` if offered (the table's own `fallback`, and the common default).
2. Otherwise the entry in `availableQuants` whose `bytesPerParam` is closest
   to `Q4_K_M`'s, resolving ties toward the smaller value.
3. If none of the parsed quants are in the table, `null` as today.

Set `quantKnown: true` for 1 and 2 — the quant is a real published artifact,
not an assumption. The footprint estimate stops being a guess, and the `?`
disappears from remote rows.

### `rank-by-downloads`

Sort remote candidates by `signals.downloads` descending, nulls last. Show
the count on the row as the visible justification for the ordering
(`4.5M dl`). Keep requesting `trendingScore` — it stays in `--json` and is
the API's sort parameter — but stop letting it determine display order.

`buildModelsUrl` defaults to `limit: 10` and `check.ts` does not override it,
so the re-ranking operates on the 10 the API's own `trendingScore` sort
returned. That is a milder version of the same bug — ranking a
novelty-truncated set — but fetching more rows to rank is a separate change
with its own rate-limit considerations. **Limit stays 10 here**; bumping it is
listed under Follow-ups.

### `dedup-remote-against-local`

Drop a remote candidate whose pull name matches a local model's name ignoring
the tag. `hfPullName` already produces `hf.co/<repoId>`, which is exactly the
local name's untagged form, so this is a set-membership check on names
normalized by stripping `:<tag>`.

### `collapse-local-by-digest`

Group `/api/tags` entries by digest. Emit one row per digest, with the other
tags listed inline. Requires carrying `digest` through `ModelInfo`; entries
without one fall back to one-row-per-name.

Display-name choice interacts with `quant-from-tag` and the two must not
fight. **Prefer a tag whose suffix resolves to a known quant; fall back to the
shortest name.** Collapse must therefore run *after* quant resolution — reverse
the order and every tag's quant is still `null` at collapse time, so the
preference cannot fire and the fallback decides alone.

**Corrected during implementation.** An earlier draft of this section justified
that ordering by claiming the shortest-name fallback "would pick `:latest` over
`:Q4_K_M`". That is false: both tags are exactly 6 characters, so shortest-name
does not discriminate between them, and the tie resolves by insertion order —
which in the real fixture happens to favour `:Q4_K_M` anyway. Replaying the
fixture through both orders produces identical output.

The ordering requirement is still real; the mechanism is just different from
what was written. Without the quant-bearing preference, the survivor is chosen
by name length and then by fixture ordering — neither of which has anything to
do with which tag carries usable information. The dependency only becomes
observable when the quant-bearing tag is both longer and later than its sibling,
so **that** is the shape the test must take; the real fixture cannot express it.
The lesson generalises: a rationale asserting a relationship between two
concrete values needs the values checked, not assumed.

### `drop-non-chat`

Exclude embedding and non-generation models from candidates. HF is already
filtered server-side by `pipeline_tag=text-generation`; the gap is the
`ollama.com` scrape (`mxbai-embed-large`) and local rows. Match on a small
name-pattern list (`embed`, `embedding`, `reranker`) applied to candidates
only — never to local models, since a user's own pulled model is theirs to
see regardless of what we think it's for.

## Verdict grouping

`BASELINE` and `CURRENT` agree on 28 of 33 current rows, spending two columns
to say one thing. Replace both columns with grouping, so the group header *is*
the verdict and the per-row annotation carries the disagreement.

Group by the **baseline** verdict — the conservative, trustworthy one — with
two derived groups for the disagreement cases:

```
severity: comfortable(0) < tight(1) < will-thrash(2)

group(baseline, current):
  baseline == 'unknown'                            -> 'unclassified'
  current  == 'unknown'                            -> baseline
  severity(current) > severity(baseline)            -> 'pressured'
  baseline == 'will-thrash'
      && severity(current) < severity(will-thrash)  -> 'over-budget'
  otherwise                                         -> baseline
```

The `over-budget` branch must test that `current` is **strictly better** than
`will-thrash`. Testing only `baseline == 'will-thrash'` sends
`(will-thrash, will-thrash)` — a model that fits nowhere — into a group
labelled "fits right now", because equal severities do not trip the
`pressured` branch above it. That case is a required test.

Total and deterministic. Rendered order and labels, where *B* is baseline
headroom and *C* is current headroom:

| Group | Label |
| --- | --- |
| `comfortable` | `comfortable` |
| `pressured` | `tight right now · only C free, other apps are holding memory` |
| `tight` | `tight · close to the B safe budget` |
| `over-budget` | `over the B safe budget · fits right now, C free` |
| `will-thrash` | `won't fit` |
| `unclassified` | `unclassified · backend didn't report a size` |

`over-budget` exists so the largest model a machine can currently run is not
filed under a header reading "won't fit". Most runs render one to three
groups. Within a group, sort by footprint descending; rows with a null
footprint sort last.

`baselineVerdict` and `currentVerdict` stay on `CheckRow` unchanged. The group
key is additive.

## Recommendations

Today `src/format.ts:124` picks the suggested model as
`rows.find(r => r.baselineVerdict !== 'unknown')` — whatever landed first in
insertion order. That is why it currently suggests
`gemma4-composer-64k:latest`: not because it is good, but because it is first.

Compute two recommendations explicitly, so sort order stops carrying meaning
it cannot express:

- **Run now** — the largest-footprint local row in `comfortable`. If a larger
  local row exists in `over-budget`, name it as the bigger-but-riskier option
  in the same sentence.
- **Worth pulling** — the highest-ranked remote row in `comfortable`.

Either line is omitted when its side has no qualifying row. The `Next:`
bench hint uses the Run now pick, and keeps pinning `--backend <id>`
(regression guarded by an existing test — see `aba46a6`).

## Output format

```
24.0G total  ·  16.0G safe budget (−8G macOS reserve)  ·  20.5G free now (−3.5G wired)

Run now        gemma3:12b · 8.6G · safe bet. gemma3:27b (19.3G) is bigger and
               fits at this moment, but needs most of your free memory.
Worth pulling  ornith-ai/Ornith-1.0-9B · 6.3G · Q4_K_M · 4.5M downloads

PULLED (6)
  comfortable
    gemma3:12b                     8.6G  Q4_K_M
    gemma4-composer-64k:latest     8.4G  Q4_K_M
    yuxinlu1/gemma-4-12B-agentic   8.4G  Q4_K_M   (:Q4_K_M, :latest)
    +2 more, 2.3G–8.4G                                        --local
  over the 16.0G safe budget · fits right now, 20.5G free
    gemma3:27b                    19.3G  Q4_K_M

PULLABLE (5 of 9, huggingface, by downloads)
  comfortable
    ornith-ai/Ornith-1.0-9B        6.3G  Q4_K_M   4.5M dl
    yuxinlu1/gemma-4-12B-coder     8.4G  Q4_K_M   283k dl
    LiquidAI/LFM2.5-2.6B           1.9G  Q4_K_M    68k dl
    LiquidAI/LFM2.5-8B-A1B         6.0G  Q4_K_M    63k dl
    RavichandranJ/Dolphin3-8B      5.6G  Q4_K_M    60k dl
    +4 more                                                   --remote

Next: llamafit bench gemma3:12b --backend ollama
```

Every figure above is real, taken from the live 2026-08-09 run: the 6 local
models after digest collapse, the 9 candidates remaining after dedup at
`limit: 10`, and footprints matching the current estimator's output. It is a
worked example, not an illustration.

Rules:

- **Header is one line and comes first.** Both headroom figures with their
  derivations, since every verdict below is relative to them. This replaces
  the two labelled lines currently printed last, and subsumes the
  macOS-reserve wording item in taskwarrior `23a848dd`.
- **Caps are symmetric: 5 rows per section**, so the local inventory gets no
  more room than the remote list. Overflow collapses to one `+N more` line
  carrying a footprint range and the flag that expands it.
- **The remote links block is deleted.** With a real quant on the row its only
  unique content was the URL, which moves to `--remote` and `--json`.
- **Cloud models are not rendered at all.** No section, no count, no line.
- **`~` prefix and the legend survive**, still emitted only when a row
  actually needs them. `~` remains meaningful: measured resident size versus
  formula estimate is a real distinction.
- Section headers state what was shown out of what was found
  (`5 of 13`), so a cap never reads as completeness.
- Empty sections print one line (`No models pulled yet.` /
  `No remote candidates found.`) rather than a bare header.

## Flags

| Flag | Behavior |
| --- | --- |
| `--local` | Full local inventory, uncapped, all columns |
| `--remote` | Full candidate list, uncapped, with URLs and signals |
| `--all` | Both, uncapped |
| `--json` | Complete and **never capped** — capping is a text-rendering concern |
| `--query <q>` | Unchanged; routes to both sources, including the scraper |
| `--backend`, `--diagnose`, `--no-color` | Unchanged |

`--cloud` is not added; the section it would expand does not exist.

## JSON contract

Additive only. `CheckRow` gains the group key; `CheckResult` gains
`recommendations: { runNow: string | null; worthPulling: string | null }`.
`cloudModels` **stays** even though nothing renders it, so existing consumers
keep working. `rows` stays uncapped and unsorted-by-contract; ordering is a
presentation concern, and the group key lets a consumer re-derive it.

Single-backend `check --json` continues to emit a bare `CheckResult` and
multi-backend continues to key by backend id, unchanged.

## Module split

`src/format.ts` is 196 lines and `formatCheckTable` is 108 of them; this
change grows it substantially. Split into:

- `src/format/table.ts` — width computation and ANSI-aware padding. Pure,
  independently testable, and the one genuinely reusable piece (the
  pad-against-plain-width rule is subtle enough to deserve its own tests).
- `src/format/check.ts` — grouping, capping, recommendations, sections.
- `src/format/bench.ts` — `formatBenchResult`, `formatPullProgress`, moved
  unchanged.

`src/format.ts` becomes a re-export barrel so no import site outside the
directory changes.

## Error handling

Unchanged in structure. Failed remote sources still warn on stderr and let
the run finish; stdout stays pipeable. The gap machinery keeps its existing
loudness for genuine gaps — `unknown-quant-sentinel` removes a false trigger
rather than softening a real one, and after it, a `unknown-quant` gap means a
real quantization is missing from the table, which is exactly when the agent
prompt earns the interruption.

One housekeeping note: `llamafit-diagnostics-*.json` is written to `cwd`, and
two accumulated there from two `check` runs while writing this spec (already
covered by `.gitignore`, so they were ignored rather than untracked — clutter
on disk, not a repo hygiene problem). Deleted. Since
`unknown-quant-sentinel` stops the only trigger this machine has, no further
bundles appear on a normal run. Moving the write location is **out of scope** —
a separate decision with its own tradeoffs (discoverability versus tidiness).

## Testing

TDD per `CLAUDE.md`: failing test first, watch it fail for the right reason.
`fixtureBackend()`/`fixtureProbe()` back the CLI-level tests; override
individual capabilities rather than hand-rolling fakes.

Per-change unit tests:

- `unknown-quant-sentinel` — `'unknown'` and `''` both yield `?` with **no**
  gap recorded; a genuinely unrecognized string still records one.
- `quant-from-tag` — `hf.co/o/r:Q4_K_M` resolves; `hf.co/o/r:latest` and
  `hf.co/o/r:bogus` fall through to `?`; a reported quant always wins over
  the tag.
- `quant-from-available` — `Q4_K_M` preferred when offered; nearest-by-bytes
  otherwise with ties toward smaller; `null` when nothing is in the table.
- `rank-by-downloads` — descending, nulls last; the `SupraLabs`-above-`ornith`
  inversion from the Evidence section is the regression fixture.
- `dedup-remote-against-local` — tag-insensitive match drops the candidate;
  a merely similar name does not.
- `collapse-local-by-digest` — two tags one digest collapse with both tags
  shown; missing digest falls back to one row per name; **the quant-bearing
  tag wins the display name over a shorter one** (`:Q4_K_M` beats `:latest`).
- `drop-non-chat` — candidates filtered, **local models never** filtered.
- Grouping — all four `group()` branches, both disagreement directions
  (`pressured` and `over-budget`), and `unclassified`.
- Recommendations — `over-budget` model larger than the `comfortable` pick is
  mentioned; each line omitted when its side is empty.
- Capping — `+N more` count and footprint range arithmetic; boundary at
  exactly 5 rows emits no overflow line.
- `format/table.ts` — padding is computed against plain width, so colorized
  cells stay aligned.

`test/output-guardrail.test.ts` snapshots are updated with
`npx vitest run test/output-guardrail.test.ts -u`. This is a deliberate
output change, which is what that file's convention covers.

Live verification, per `CLAUDE.md` — unit tests alone do not close this out:

1. `npm run dev -- check` against the real `ollama`, confirming the new
   default query returns usable candidates and no gap block appears.
2. `npm run dev -- check --query gemma` confirming the scraper still
   contributes on the `--query` path.
3. **Copy the printed `Next:` line and run it verbatim.** The bug in `aba46a6`
   lived in exactly this seam.
4. `npm run typecheck` **and** `npm run build` — separate configs.

## Non-goals

- `check <model>` as a positional ("can I run X?"). Not named as a core job.
- Retuning the 8G reserve, `tightRatio`/`thrashRatio`, or the overhead
  multiplier. That is the calibrated model from
  `2026-08-04-ollama-scope-cli-design.md`, grounded in measurements.
- A size floor on candidates. Explicitly declined.
- An interactive/TUI picker. Considered and set aside; the capped sections
  plus `--local`/`--remote` cover the same need without a new dependency or a
  TTY-versus-pipe split.
- Moving the diagnostics bundle out of `cwd`.
- Per-model page fetches to fill in the scraper's missing sizes.

## Follow-ups

- Taskwarrior `23a848dd` ("generalize format.ts labels") partially lands here:
  the macOS-reserve wording moves into the new header line, and the
  cloud-models label becomes moot. The `modelPageUrl` ollama-link item is
  untouched and stays open.
- Raise the HF `limit` above 10 so `rank-by-downloads` re-ranks a wider set
  instead of the API's trending top 10. Needs a look at anonymous rate limits
  (500 requests / 5 minutes) and whether the extra rows survive the size cap.
- Move the diagnostics bundle out of `cwd`. Deliberately excluded above; worth
  its own decision.
