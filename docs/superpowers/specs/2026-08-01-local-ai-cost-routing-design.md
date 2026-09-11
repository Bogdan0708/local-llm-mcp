# Local-AI Cost Routing — Design Spec

**Date:** 2026-08-01
**Status:** Approved approach (Approach A), pending final user review of this document
**Hardware:** HP ZBook Ultra G1a — Ryzen AI Max+ 395 (Strix Halo), 128 GB unified RAM, Radeon 8060S iGPU
**Reviewed by:** two external audit rounds; all corrections incorporated

## 1. Goal and non-goals

**Goal:** Reduce Claude generation work by routing mechanical tasks to a local model via the existing `local-llm` MCP server, with best-effort automatic delegation inside Claude Code sessions. Delegation is intended to reduce Claude generation work. Its effect on plan quota is evaluated separately and is not inferred directly from local token volume.

**Non-goals (explicitly out of scope for v1):**
- NPU/Lemonade, WSL ROCm, ai-gateway integration, disk cleanup, Adrenalin upgrade
- Multi-model routing (v1 routes to exactly one model)
- Privacy isolation: **this is cost routing, not a privacy boundary.** Claude remains the cloud orchestrator and sees all tool inputs and outputs in its context. A local-privacy lane would be a separate design.

## 2. Decisions from brainstorming

| Decision | Choice |
|---|---|
| Primary win | Reduce Claude generation work / preserve plan quota |
| Routing style | Best-effort automatic delegation per user-global memory rules |
| Backbone | LM Studio server on Windows, reached from WSL via mirrored-networking localhost |
| First workload | All daily Claude Code work immediately |
| Guiding principle | Simplicity beats complexity — no new services, no gateway |

## 3. Architecture

```
Claude Code (WSL) — best-effort delegation per ~/.claude/CLAUDE.md rules
   │
   ▼
local-llm MCP server  (source of truth: ~/local-llm/mcp-server/)
   │  http://localhost:1234  (WSL mirrored networking → Windows loopback)
   ▼
LM Studio 0.4.20 server (Windows, Vulkan runtime, 127.0.0.1 only)
   └─ v1 model: Qwen3.6-35B-A3B Q4_K_M (provisional — see §4)
```

Three components, all pre-existing. No new services, databases, or daemons.

## 4. Model selection

> Provisional v1 default: **Qwen3.6-35B-A3B Q4_K_M**. Newer and broader than Qwen3-Coder-30B, with strong vendor-reported agentic results; final selection is subject to a same-machine local comparison. Expected ordinary Q4_K_M throughput is approximately **60–70 tok/s**. Higher MTP throughput must be measured separately and is not assumed.

Vendor-reported SWE-bench Verified 73.4 was produced with Qwen's internal scaffold and is not directly comparable across model families; independent reproductions have scored lower. It is treated as promising, not proven.

| Rank | Model | Role |
|---|---|---|
| #1 provisional | Qwen3.6-35B-A3B (installed) | Proposed v1 default |
| #2 pre-lock control | Qwen3-Coder-30B-A3B (installed) | Same-machine comparison before the default is locked |
| #3 later challenger | GLM-4.7-Flash (~17 GB download) | Only if both installed candidates leave a quality gap; its Strix Halo speed is unknown until measured (open llama.cpp report of it running unusually slowly for an A3B model) |
| #4 heavy tier | Qwen3-Coder-Next (~48–51 GB, ~38–43 tok/s community-measured) | Later evaluation; not part of v1 |

**Pre-lock comparison:** before the default is locked, both installed candidates run the same fixed case set (one representative case per MCP tool plus one commit-draft and one data-transform case through `local_ask`). Outputs are judged by Claude review, and generated tests are executed. The winner becomes the v1 default; the loser is simply not routed. This does not violate single-model v1 routing.

**Reasoning mode:** Qwen3.6 reasoning is explicitly disabled for v1 routine delegation and verified during smoke testing. No default/automatic reasoning setting is accepted silently. The exact payload is proven against LM Studio 0.4.20 during implementation: if the native `/api/v1/chat` endpoint is used, specify `reasoning: "off"` and `store: false`; if `/v1/chat/completions` is retained, prove the corresponding compatibility setting and preserve `finish_reason` handling.

**Tool-calling caveat (dismissed for v1):** the MCP requests plain chat completions — the local model never makes tool calls itself — so reported Qwen3.6 tool-calling weaknesses do not affect this design.

The exact LM Studio model ID is confirmed against `/v1/models` during implementation (LM Studio is currently offline; ID cannot be confirmed from this design session).

## 5. Version control and cutover

- MCP source moves to `~/local-llm/mcp-server/`: `server.js`, `package.json`, lockfile. `mcp-server/node_modules/` goes in `.gitignore`; dependencies installed with `npm ci`.
- `~/.claude.json` `local-llm` entry re-pointed to the repo copy.
- After verified cutover (smoke tests pass against the repo copy), the old unversioned implementation at `~/.claude/mcp-servers/local-llm/` is removed so the repository is the single source of truth.

## 6. MCP server changes (`server.js`)

- **Defaults:** URL `http://localhost:1234`; model = confirmed Qwen3.6 ID. Both env-overridable (`LM_STUDIO_URL`, `LM_STUDIO_MODEL`).
- **Preflight (2 s):** confirms LM Studio reachability and that the requested model ID exists in `/v1/models`. This is a reachability-and-presence check only; it does not prove a load will succeed (JIT lists downloaded models even when none are loaded).
- **Timeout:** `LOCAL_LLM_TIMEOUT_MS`, initial 180 000 ms; validated with cold-load and warm tests. Timeouts are logged distinctly from offline failures.
- **Serialization:** local generations are serialized through an in-process FIFO queue — one in-flight request to LM Studio at a time. The timeout is measured from request receipt and therefore includes queue wait, so a queued call can never hang silently past its budget.
- **Sampling:** `max_tokens` raised from 4096 to an initial 16 384 (test generation currently truncates) and temperature lowered from 0.7 to an initial 0.2 for code tasks; both configurable via env (`LOCAL_LLM_MAX_TOKENS`, `LOCAL_LLM_TEMPERATURE`).
- **Reasoning:** disabled per §4, with the proven payload for 0.4.20.
- **Security scope removal:** `security` is removed from the `local_code_review` focus input description *and* from its default focus prompt. The MCP tool itself must not advertise the prohibited capability.
- **`local_ask` broadened deliberately:** the tool description *and its input property descriptions* cover coding questions, summaries, commit-message drafts, and data transformation — closing the coverage gap without adding tools.

## 7. Usage log

Append-only JSONL at `~/.claude/local-llm-usage.jsonl`, one line per call:

- Fields: timestamp, tool, model, status, prompt_tokens, completion_tokens, duration_ms, finish_reason.
- Status values: `success`, `offline`, `model-missing`, `timeout`, `http-error`, `malformed`, `context-overflow`, `truncated`.
- Failure rows use `null` for unavailable token and finish-reason fields.
- A metrics-write failure warns to **stderr only** (the failed logging sink cannot reliably log its own failure) and never discards a successful answer.

## 8. Routing rules

A **best-effort automatic delegation** policy is added to the user-global memory file `~/.claude/CLAUDE.md` (loaded in every session; advisory, not enforced — verified loaded via `/memory`):

- **Delegate to local (announced, not asked):** test scaffolding/generation, documentation drafts, code summaries, commit-message drafts, data extraction/transformation, boilerplate, first-pass code review.
- **Never delegate:** architecture decisions, debugging, security-sensitive work, anything delivered to a client without review.
- **Quality gate:** Claude reviews every local output before use; inadequate output is redone by Claude silently.
- **Fallback:** local offline → Claude does the work itself and mentions it once per session. No retry loops, never blocks.

**All four command files** (`~/.claude/commands/local-ask.md`, `local-review.md`, `local-docs.md`, `local-tests.md`) are updated to match — including removing `local-review.md`'s "security concerns" delegation and its claim that local review may be sufficient; local review output is always Claude-reviewed.

## 9. Error handling

Eight cases, all ending with the user getting a result:

1. **Offline** → preflight fast-fail, Claude does the work, no retry loop.
2. **Requested model missing** → distinct error, Claude falls back.
3. **Timeout** → logged as `timeout` (distinct from offline), Claude falls back.
4. **HTTP failure** → status + body logged, Claude falls back.
5. **Malformed/empty response** → logged `malformed`, Claude falls back.
6. **Context overflow** → logged `context-overflow`; Claude retries locally with tighter scope or takes over.
7. **Truncated output** (`finish_reason: length`) → logged `truncated`; Claude decides: tighter scope retry or take over.
8. **Metrics-write failure** → stderr warning only; successful answer still returned.

## 10. Measurement — what each source can and cannot show

- **JSONL log:** local utilization, reliability, and latency (call count, success rate, fallback rate, p50/p95 duration, local tokens). It records only calls that happened; it cannot see eligible tasks that were never delegated.
- **Delegation adherence:** manual/sample audit of Claude session transcripts against eligible tasks.
- **`/usage` comparison:** suggestive, not causal proof of savings. This machine uses subscription authentication with extra usage disabled; local calls still consume some Claude context because Claude sends, receives, and reviews tool content.
- **Week-one report:** all JSONL metrics + adherence sample + `/usage` observation, and a model-quality verdict (does anything justify the GLM-4.7-Flash download?).

## 11. Security

- LM Studio stays bound to `127.0.0.1`; "Serve on Local Network" off; CORS off.
- Verification is against the **actual Windows listener** (e.g., `netstat` showing `127.0.0.1:1234` and no `0.0.0.0`/LAN binding), not merely the GUI toggle.
- Privacy non-claim restated: cost routing only; Claude sees all tool I/O.

## 12. Testing gates (all pass before the one-week trial)

1. All four MCP tools, cold-load and warm.
2. Offline fallback with no retry loop.
3. Unknown-model test and controlled-timeout test.
4. Truncated and malformed response handling.
5. JSONL validation: success and failure rows, status values, error codes, finish_reason, `null` handling for missing token counts.
6. Reasoning-off verification (no reasoning tokens in routine outputs).
7. Serialization test: two concurrent tool calls → sequential execution, both within timeout budget.
8. Fresh Claude Code session: `/memory` shows routing rules, `/mcp` shows the server.
9. Generated tests are **executed**, not merely inspected.
10. Windows listener loopback verification (§11).
11. Pre-lock model comparison (§4) completed and default locked.
12. Then: one-week live trial and report (§10).

## 13. One-time Windows setup (user, ~2 minutes)

Update LM Studio 0.4.8 → 0.4.20; enable the server (port 1234, auto-start on launch, loopback only, CORS off). Everything else is done from WSL. The server can also be started headlessly via `lms.exe server start` if the GUI is closed.
