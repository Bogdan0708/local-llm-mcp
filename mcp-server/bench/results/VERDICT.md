# Bench Verdict: model_1 vs model_2

Blind judged across 6 cases. Scores are 0-10 (correctness, instruction-following, format discipline combined). Duration is informational; quality dominates the score, duration is only a tiebreaker at equal quality.

| Case | model_1 | model_2 | duration_1 | duration_2 | Note |
|---|---|---|---|---|---|
| ask-question | 8.5 | 9.0 | 53,738 ms | 17,385 ms | Both correctly diagnose the missing-`return` / double-header-send bug and give a working fix; model_2 is equally correct but ~3x faster and more concise. |
| commit-draft | 9.0 | 7.5 | 11,298 ms | 6,530 ms | Both mention the validation helper and the referral null-check; model_1 also states the "why" (prevents undefined-ref crash) per judging notes, model_2 adds an unsubstantiated bullet about status codes that the diff didn't actually change. |
| docs | 8.5 | 8.5 | 21,994 ms | 15,081 ms | Near-identical JSDoc coverage of both input forms, return semantics, and the throw case; both share the same minor "returns 0 if invalid" / "@throws" inconsistency. Tie; model_2 faster. |
| transform | 9.0 | 9.0 | 27,469 ms | 27,651 ms | Both produce correct header/row order/format with no stray prose; each has exactly one wrong VAT rounding out of 20 rows (model_1 wrong on Gadget C, model_2 wrong on Battery K) — verified against a reference calculation. Tie. |
| review | 9.5 | 8.5 | 65,392 ms | 25,068 ms | Both find BOTH seeded bugs (off-by-one slice, unchecked `overrides.notifications`) with correct fixes. model_1 goes further, correctly flagging the `||` vs `??` falsy-value pitfall and out-of-bounds-page edge case; model_2 is more concise and 2.6x faster but shallower. |
| tests | 8.5 | 6.0 | 125,353 ms | 128,541 ms | See execution results below — model_1's suite is smaller but far more reliable (14/15 pass, 1 failure from a flawed assertion); model_2 generated nearly 2x the tests but ~26% embed incorrect assumptions about the function's actual behavior (wrongly expects it to throw on invalid/missing/null dates, and expects zero-padded years), yielding 20/27 passing. |
| **Total** | **53.0** | **48.5** | | | |

## Execution results — tests case

Both models' generated `node:test` files were extracted, paired with the function under test (`groupInvoicesByQuarter`), and run via `node --test` in isolated scratch directories.

**model_1** — 15 tests generated, ran without crashing:
- 14 passed, 1 failed
- Covers all required scenarios (empty input, single-quarter grouping, multi-quarter/year spanning, summation correctness) correctly
- The one failure is a genuinely incorrect assertion: the test comment claims "null + undefined + 100 = 100 in JavaScript," but `undefined` addition actually produces `NaN`, so the function legitimately returns `NaN` there and the test's expectation (not the function) is wrong. This is a minor, out-of-scope edge case beyond what the judging notes required.

**model_2** — 27 tests generated, ran without crashing:
- 20 passed, 7 failed
- Covers all required scenarios correctly, plus a large volume of extra edge cases
- 6 of the failures stem from incorrectly assuming the function throws on invalid/missing/null/undefined dates — the actual implementation quietly produces `NaN`/`"NaN-QNaN"` keys rather than throwing, so these assertions reflect a wrong model of the function's behavior, not real bugs in it
- 1 more failure expects zero-padded year formatting (`'0000-Q1'`) that the function does not perform

Net effect: model_2's larger test count does not translate into better quality — over a quarter of its assertions misunderstand the function's actual (unguarded/non-throwing) behavior, versus one flawed assertion for model_1.

## Winner: model_1

model_1 wins 53.0 to 48.5. It ties or slightly trails model_2 on the simpler, high-throughput cases (ask-question, docs, transform) where model_2's speed is the only differentiator at equal quality, but it pulls ahead decisively on the two cases that reward depth: the code review case, where it independently surfaces a real `||`/`??` falsy-value pitfall beyond the two required seeded bugs, and the test-generation case, where its smaller suite is materially more correct (14/15 vs 20/27, with far fewer assertions built on wrong assumptions about the function under test). model_2 is consistently 2-3x faster and matches model_1 on straightforward formatting/transformation tasks, making it a reasonable choice when speed matters more than depth, but on correctness-heavy tasks it trades volume for reliability in a way that lowers overall quality.

## Resolved mapping (unblinded after judging)

- model_1 = qwen/qwen3.6-35b-a3b (WINNER — remains v1 default in lib.js, no change needed)
- model_2 = qwen/qwen3-coder-30b (not routed in v1)


---

# Addendum 2026-09-02: model_3 = qwen/qwen3.8-27b (dense, Q4_K_M), on mains

Same six cases, same MCP path (native endpoint, reasoning off), judged against the same notes. model_1 durations are from 2026-08-01 under different conditions — compare quality, not wall time.

| Case | model_1 (3.6-35b-a3b) | model_3 (3.8-27b) | duration_3 | Note |
|---|---|---|---|---|
| ask-question | 8.5 | 9.0 | 31,051 ms | Same diagnosis (missing `return`), cleaner fix using `return res.status()`. |
| commit-draft | 9.0 | 9.0 | 17,729 ms | Names both the helper and the referral null-check crash; slightly over-describes the helper's internals. |
| docs | 8.5 | 9.0 | 30,686 ms | Covers both input forms, return, throw; drops the "returns 0 if invalid" contradiction both earlier models had. |
| transform | 9.0 | 10.0 | 29,202 ms | 20/20 rows correct against a Decimal reference (model_1 had Gadget C VAT 18.99 vs 19.00). |
| review | 9.5 | 9.5 | 60,684 ms | Both seeded bugs + the `||`/`??` pitfall + empty-array note. Equal. |
| tests | 8.5 | 10.0 | 181,709 ms | 22 tests generated, **22/22 pass** with `node --test` (model_1 14/15, model_2 20/27). Covers all four required scenarios plus boundaries, TZ offsets, leap year. **Exceeded the MCP's 180 s timeout on the first run** — completed only with LOCAL_LLM_TIMEOUT_MS=590000. |
| **Total** | **53.0** | **56.5** | | |

## Verdict
model_3 (qwen3.8-27b) wins on quality, 56.5 vs 53.0, with zero correctness errors across all six cases. Cost: ~3x lower raw throughput (17 tok/s gen, 156 tok/s cold prefill vs 50 / 485 on mains) and the tests case needs a longer MCP timeout. Recommendation: make it the local-llm default with LOCAL_LLM_TIMEOUT_MS raised to ~360000; keep qwen3.6-35b-a3b for latency-sensitive interactive use (Hermes /model).


---

# Addendum 2026-09-02: model_4 = openai/gpt-oss-120b (MXFP4), on BATTERY

Same six cases, same MCP path. Battery run, so durations are pessimistic.

| Case | model_1 (3.6-35b-a3b) | model_3 (3.8-27b) | model_4 (gpt-oss-120b) | duration_4 | Note |
|---|---|---|---|---|---|
| ask-question | 8.5 | 9.0 | 9.0 | 32,511 ms | Correct root cause, offers return-vs-else-if options; wordier. |
| commit-draft | 9.0 | 9.0 | 8.5 | 7,906 ms | Names both changes; uses `feat` for a fix and slightly misdescribes the guard as "optional lookup". |
| docs | 8.5 | 9.0 | 8.5 | 22,168 ms | Complete and internally consistent, but silently dropped the TS `value: string` annotation from the signature. |
| transform | 9.0 | 10.0 | 10.0 | 32,211 ms | 20/20 rows correct, no prose. |
| review | 9.5 | 9.5 | 9.5 | 76,376 ms | Both seeded bugs, `??` pitfall, plus integer validation and totalPages≥1 ideas. Verbose. |
| tests | 8.5 | 10.0 | 9.0 | 68,038 ms | 7 tests, **7/7 pass**; covers all four required scenarios plus a correct NaN-key test for invalid dates. Deductions: ESM `import` against a CommonJS module (would not run as delivered), lean count. |
| **Total** | **53.0** | **56.5** | **54.5** | | |

## Verdict
gpt-oss-120b lands between the two Qwens: 54.5. Zero correctness errors, fastest tests case by far (68 s vs 182 s), but it takes small liberties with the given contract (commit type, TS signature, module system). Speed on battery ≈ qwen3.6 on battery (32 tok/s gen, ~290 tok/s cold prefill); memory says ~51–57 tok/s on mains. Ranking: qwen3.8-27b (quality) > gpt-oss-120b (balanced) > qwen3.6-35b-a3b (speed).

**Bench defect found:** `cases/review.json` input contains `// BUG (seeded, …)` comments that name both bugs. Every model read them, so the review case does not discriminate. Reseed without the comments before the next comparison.


---

# Addendum 2026-09-02: model_5 = google/gemma-4-31b (dense, Q4_K_M), on BATTERY

| Case | 3.6-35b-a3b | 3.8-27b | gpt-oss-120b | gemma-4-31b | duration_5 | Note |
|---|---|---|---|---|---|---|
| ask-question | 8.5 | 9.0 | 9.0 | 9.0 | 76,311 ms | Correct, concise, names ERR_HTTP_HEADERS_SENT explicitly. |
| commit-draft | 9.0 | 9.0 | 8.5 | 8.5 | 35,862 ms | Both changes named; `feat` on a fix; terse bullets. |
| docs | 8.5 | 9.0 | 8.5 | 8.0 | 51,204 ms | JSDoc covers both forms, return, throw — but replaced the function body with `// ... implementation`. |
| transform | 9.0 | 10.0 | 10.0 | 10.0 | 93,891 ms | 20/20 correct, no prose. |
| review | 9.5 | 9.5 | 9.5 | 9.0 | 157,667 ms | Both seeded bugs (giveaway case), `??` advice, edge cases; least depth of the four. |
| tests | 8.5 | 10.0 | 9.0 | 7.5 | 243,960 ms | 7 tests, **6/7 pass**; the failure asserts a throw on invalid dates (function yields a NaN key) — a wrong model of the code, coder-30b's failure class. Placeholder `require('./your-file-name')`. |
| **Total** | **53.0** | **56.5** | **54.5** | **52.0** | | |

## Verdict
gemma-4-31b scores lowest of the four (52.0) and is by far the slowest: 8 tok/s gen / 56 tok/s prefill on battery, tests case 244 s. No reason to route to it for delegation on this machine. Final ranking: qwen3.8-27b 56.5 > gpt-oss-120b 54.5 > qwen3.6-35b-a3b 53.0 > gemma-4-31b 52.0.


---

# Addendum 2026-09-02: model_6 = openai/gpt-oss-20b (MXFP4), on BATTERY (47%)

| Case | 3.6-35b-a3b | 3.8-27b | gpt-oss-120b | gemma-4-31b | gpt-oss-20b | duration_6 | Note |
|---|---|---|---|---|---|---|---|
| ask-question | 8.5 | 9.0 | 9.0 | 9.0 | 8.0 | 14,861 ms | Fix is right, but the lead explanation ("error matches more than one branch") is the wrong mechanism; the real cause (unconditional `next(err)`) is mentioned second. |
| commit-draft | 9.0 | 9.0 | 8.5 | 8.5 | 7.0 | 2,924 ms | `refactor` on a fix; invents an `invalid_email` error and "more precise status codes" not in the diff; misdescribes the null-check as optional lookup. |
| docs | 8.5 | 9.0 | 8.5 | 8.0 | 9.0 | 13,651 ms | Complete, consistent, keeps the TS signature, realistic date example. |
| transform | 9.0 | 10.0 | 10.0 | 10.0 | 9.0 | 17,142 ms | 19/20 — Enclosure P VAT 31.68 vs 31.66. |
| review | 9.5 | 9.5 | 9.5 | 9.0 | 9.0 | 24,886 ms | Both seeded bugs (giveaway case), edge-case tables, no `??` observation. |
| tests | 8.5 | 10.0 | 9.0 | 7.5 | 7.5 | 32,121 ms | 7 tests, 6/7; the failure assumes string amounts coerce to numbers (JS concatenates). NaN-key behaviour modelled correctly. |
| **Total** | **53.0** | **56.5** | **54.5** | **52.0** | **49.5** | | |

## Verdict
gpt-oss-20b is the fastest model tested by a wide margin (43 tok/s gen, ~1.4k tok/s cold prefill on battery; whole bench in ~106 s vs 8–11 min for the dense models) and the lowest quality (49.5): it fabricates in the commit draft and misreads mechanisms. Use it only where speed dominates and output is reviewed anyway (titles, summaries, first-pass drafts), never for tests or commit messages.


---

# Addendum 2026-09-02: model_7 = qwen/qwen3.8-27b, run 2 (battery 43%→13%, patched lib)

Stability check of the leader. All five prose cases are near-verbatim repeats of run 1 (same seeded bugs + `??` note in review, same Express diagnosis, same commit body, same JSDoc); transform 20/20 again; tests **23/23 pass** (run 1: 22/22). Score holds at **56.5**. Durations (battery): ask 56 s, commit 22 s, docs 45 s, transform 51 s, review 108 s, tests 166 s.

The tests case first failed twice as `[offline] fetch failed` at ~285 s — not the model: undici's 300 s `headersTimeout` in Node's global fetch. Fixed in `lib.js` (own undici Agent, headersTimeout/bodyTimeout 0). See AAR 2026-09-02.


---

# Addendum 2026-09-02: model_8 = qwen/qwen3.8-27b, run 3 (MAINS, patched lib)

Third run of the leader, first full run on mains through the fixed client. Same findings as runs 1–2 (both seeded bugs + `??`, same Express fix, transform 20/20), tests **25/25 pass**. Score **56.5** on all three runs — stable.

| Case | run 1 (mains, Aug-lib) | run 2 (battery) | run 3 (mains) |
|---|---|---|---|
| ask-question | 31 s | 56 s | 31 s |
| commit-draft | 18 s | 22 s | 13 s |
| docs | 31 s | 45 s | 26 s |
| transform | 29 s | 51 s | 25 s |
| review | 61 s | 108 s | 57 s |
| tests | 182 s | 166 s | 209 s |

Mains cuts the prose cases ~40–50% vs battery. Tests stays ~3 min regardless (output-bound, 23–25 tests). Operational: with the default default `LOCAL_LLM_TIMEOUT_MS=180000`, the tests tool would still time out on this model — set ≥360000 if it becomes the default.
