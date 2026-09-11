# Local AI on the HP ZBook Ultra G1a (Ryzen AI Max+ 395 "Strix Halo", 128GB)

> Status: implementation evidence; no live/hosted service claimed. `mcp-server/` is a working,
> tested MCP server run locally via Claude Code; the rest of this repo is the hardware/software
> research that informed it.

## What's in this repo

**`mcp-server/`** — an MCP (Model Context Protocol) server that lets Claude Code delegate
routine work to a local model served by LM Studio, instead of spending Claude's own generation
budget on it:

- **Local-model adapter** (`lib.js`, `server.js`): exposes four tools —
  `local_ask`, `local_code_review`, `local_generate_docs`, `local_generate_tests` — each
  building a task-specific system/user prompt and forwarding it to an OpenAI-compatible
  `/v1/chat/completions` endpoint (LM Studio by default, `http://localhost:1234`).
- **Queue + deadline handling**: calls are serialized through a single promise queue (one
  in-flight request at a time; a failed call never blocks the queue), and every call runs
  against a single wall-clock deadline (`LOCAL_LLM_TIMEOUT_MS`, default 360 s) that covers
  queue-wait, preflight, and the request itself — so a slow model degrades to a clean timeout
  instead of hanging Claude Code. undici's default 300 s `headersTimeout` is explicitly
  disabled because non-streaming LM Studio responses send no headers until generation
  finishes, which was silently killing anything slower than 5 minutes.
  Errors are typed (`offline`, `model-missing`, `timeout`, `http-error`, `malformed`,
  `context-overflow`, `truncated`) so the caller gets an actionable message rather than a
  generic failure.
- **Telemetry**: every call appends a JSONL row (`logUsage` in `lib.js`, default
  `~/.claude/local-llm-usage.jsonl`) recording tool, timestamp, duration, and outcome, used
  to compare models in `mcp-server/bench/`.
- **Tests**: `mcp-server/test/lib.test.js` — 31 unit tests (Node's built-in test runner,
  `npm test`) covering config parsing, prompt building, error classification, and tool
  definitions.
- **`mcp-server/bench/`**: harnesses used to pick the current default model
  (`bench/compare.mjs`, `bench/judge-mechanical.py`) plus a regression check for the
  headers-timeout fix (`bench/verify-long-headers.mjs`); `bench/results/VERDICT.md` is the
  benchmark writeup.
- **`docs/superpowers/specs/`**: the design spec for a follow-on cost-routing feature
  (best-effort automatic delegation of mechanical Claude Code work to this server).

**Everything else in the repo root** (`findings.md`, `sources.md`, `raw-research.json`,
`setup-checklist.md`) is the hardware/software research (below) that the MCP server's default
model choice and timeout values were tuned against.

> Research compiled 2026-06-21 via a deep-research pass (110 agents, 27 sources, 134 claims
> extracted, 25 adversarially fact-checked → 22 confirmed, 3 killed).
> Companion files: `findings.md` (verified claims + evidence), `sources.md` (source list),
> `raw-research.json` (full workflow output).

## TL;DR — what your machine can actually do

Your laptop is, in AMD's own framing, a **flagship local-AI platform** — they treat the 128GB
Ryzen AI Max+ 395 as *the* part for people who "must run the highest-quality model" locally.

- **Run 4-bit models up to ~128B parameters**, or **FP16 models up to ~32B**, entirely on the
  integrated Radeon 8060S GPU.
- **`gpt-oss-120b` runs at ~50–57 tokens/sec generation** and ~685–720 tok/sec prompt processing.
- Both **OpenClaw** and **Nous Hermes Agent** run on it. AMD publishes an official "Best Known
  Configuration" for OpenClaw on this chip.
- You can wire local models into **Claude Code and Codex** to offload grunt work and keep
  sensitive code on-device.

---

## 1. The memory model — why 128GB unified is the whole point

On a discrete GPU, "VRAM" is separate fast memory and "system RAM" is slow — spilling over kills
you. **Strix Halo is different: the memory is physically shared and mapped, not partitioned.**
Per AMD's ROCm docs verbatim: *"Because memory is physically shared, there's no performance
distinction like that of discrete GPUs where dedicated VRAM is significantly faster than system
memory."*

What this means in practice:
- The iGPU can address **~96–112GB** of your 128GB pool for a model.
- The real bottleneck is **memory bandwidth (~256 GB/s LPDDR5X)**, not capacity, and it applies
  equally to "VRAM" and "GTT" — they're the same physical RAM.
- That bandwidth is why generation tops out around 50–60 tok/sec on big models — it's a
  bandwidth-bound, not capacity-bound, machine.

### How to unlock the memory

**Windows (lowest friction, AMD's official path):**
1. Open **AMD Adrenalin → Performance → Tuning → Variable Graphics Memory (VGM)**.
2. Set it to **96GB** (best performance is when workloads stay ≤96GB; the iGPU can technically
   reach ~112GB if needed).
3. **Restart.** VGM is a BIOS-level reallocation that creates one contiguous dedicated block.
   - ⚠️ By default a 128GB system exposes only **512MB** to graphics — you *must* do this step.

**Linux (more headroom, more friction):**
1. Keep the **BIOS dedicated VRAM reservation tiny (0.5GB)**.
2. Raise the shared **TTM/GTT limit** instead — default is only ~50% of RAM. Use
   `/sys/module/ttm/parameters/pages_limit` (value is in *pages*, not bytes) or the `amd-ttm`
   utility (e.g. `amd-ttm --set 100` for ~100GB), then reboot.
   - ⚠️ Known friction (ROCm issue #5562): Strix Halo needs `ttm.pages_limit` (not the
     Instinct-class `amdttm.*` name), and some users hit a **62GB cap bug**.

---

## 2. The software stack & benchmarks

### Inference backends — ROCm vs Vulkan
**Workload-dependent — neither is a clean winner** (a sweeping "Vulkan beats ROCm on everything"
claim was *refuted 0-3* in verification):
- **Vulkan (RADV)** often **matches or beats ROCm on token generation** (e.g. GLM-4.7-Flash-Q8:
  Vulkan ~41 vs ROCm ~35 tg t/s).
- **ROCm** sometimes wins prompt processing — but not always.
- **Takeaway:** install both, benchmark your specific models. The reference benchmark suite for
  this exact chip is **kyuz0's amd-strix-halo-toolboxes** (reproducible CSVs).

### Verified performance numbers (this exact 128GB APU)
| Model | Backend | Prompt processing | Generation |
|---|---|---|---|
| gpt-oss-120b (MXFP4, ~59GiB) | ROCm | ~685 tok/s | ~51 tok/s |
| gpt-oss-120b (MXFP4) | Vulkan | ~720 tok/s | ~57 tok/s |
| Qwen 3.5 35B A3B (via OpenClaw) | LM Studio/llama.cpp | 10k tokens in ~19.5s | ~45 tok/s |

### Tools to install
- **LM Studio** — AMD's officially-blessed path (llama.cpp backend, GUI, OpenAI-compatible server
  on `localhost:1234`). Easiest start.
- **llama.cpp** — the engine under everything; build with ROCm or Vulkan.
- **Ollama** — simplest CLI server, used in the Hermes local guide.

### ⚠️ Honest gap: the NPU (XDNA 2) and Lemonade/GAIA
The verification process could **not substantiate meaningful NPU-accelerated LLM inference** on
this platform. All real throughput today comes from the **iGPU (8060S) via llama.cpp/ROCm/Vulkan**,
*not* the NPU. The NPU is currently more relevant for embeddings/small-model offload than for
running 70B–120B chat models. Don't build your plan around the NPU. (Open question, not settled.)

---

## 3. Running the agents: OpenClaw and Hermes

### OpenClaw — AMD officially supports it on your chip
AMD publishes a **Best Known Configuration** to run OpenClaw locally on the Ryzen AI Max+:
- **Path:** WSL2 (Ubuntu 24.04) on Windows → **LM Studio** (llama.cpp backend) for fully-local
  model serving.
- **Performance:** ~45 tok/sec on Qwen 3.5 35B A3B, ~260K-token context window, **up to 6 agents
  concurrently** (AMD best-case vendor numbers — corroborated but optimistic).
- **`Memory.md` works fully locally** — switch the default cloud embedding model to a local one
  via the `memorysearch` parameter in `openclaw.json`.

**Setup essentials:**
- OpenClaw is **endpoint-agnostic** — talks to any OpenAI-compatible `/v1/chat/completions`
  server. Documented backends: **LM Studio (native, provider id `lmstudio`,
  `http://localhost:1234/v1`), Ollama, vLLM, SGLang, MLX, LiteLLM**.
- **Use a model with >~50k context** — agent tooling eats context fast. Docs use
  `qwen/qwen3.5-9b` as the example, but with your RAM you can go much bigger.
- OpenClaw's docs say **local-only is "the strongest privacy path."**

### Nous Hermes Agent — important distinction
**Hermes Agent does NOT run inference locally itself.** It's an orchestration layer that calls
*external* OpenAI-compatible endpoints. Per Nous's docs: *"no local GPU is required for the agent
itself."*

On your ZBook the pattern is:
1. Run **LM Studio or Ollama** serving a Hermes *model* on your iGPU.
2. Point the **Hermes Agent** at `http://localhost:...` — your Strix Halo serves the *model*, the
   agent is just the driver.
3. Cost: **$0.00 API + ~$0.01–0.05/session electricity**, zero data egress, no telemetry
   (vs ~$0.80/session on Claude per Nous's own comparison).

---

## 4. Cutting your Claude/Codex bill while keeping code confidential

### Approach A: MCP delegation (recommended) — strongest verification (3-0)
**`mcp-local-llm`** lets Claude Code **delegate routine work to your local model** while Claude
stays in control: *"Claude does the thinking; your local model handles the grunt work."*

Tools: `local_summarize`, `local_draft`, `local_classify`, `local_extract`, `local_transform`,
`local_complete`, `local_status`.

**The recommended task split:**

| Send to **local** model (free, on-device) | Keep on **cloud** (Claude/Codex) |
|---|---|
| Bulk summarization | Complex reasoning / architecture |
| Boilerplate generation | Novel problem-solving |
| Extraction / formatting | **Security-sensitive operations** |
| Simple classification | Final review & decisions |
| Initial drafts | |

> You already have a `local-llm` MCP server connected (`mcp__local-llm__local_ask`,
> `local_code_review`, `local_generate_docs`, `local_generate_tests`) and local skills
> (`/local-ask`, `/local-review`, `/local-docs`, `/local-tests`). Point it at an LM Studio
> server backed by your iGPU and the loop runs.

### Approach B: Direct endpoint swap
Point Claude Code at a local server via **`ANTHROPIC_BASE_URL`**. **Docker Model Runner**
(Docker Desktop 4.58.0+, ~Jan 2026) exposes an **Anthropic-compatible Messages API**
(`/v1/messages`):
```bash
ANTHROPIC_BASE_URL=http://localhost:12434 claude --model <local-model>
```
⚠️ Caveats (the "keeps the standard Claude experience" claim was *refuted 1-2*): local models
have **small default context windows**, port 12434 can conflict, and WSL needs mirrored
networking. Works, but not a transparent drop-in for full Claude quality.

### Confidentiality bottom line
**Local-only inference is the strongest privacy path** (verified 3-0): zero data egress beyond
the one-time model download, no telemetry. For Primaria/FondEU work touching citizen tax data and
EU-funds records — **route anything with PII/regulated data through the local model, keep only
abstract architecture questions on the cloud.**

---

## 5. Final recommendation: Windows vs Linux

**Start on Windows. Move power-user workloads to Linux later if you hit walls.**

| | **Windows** (recommended start) | **Linux** (power-user) |
|---|---|---|
| Memory unlock | Adrenalin VGM → 96GB, restart. Simple. | TTM/GTT tuning, ~110GB possible, but buggy |
| Official support | AMD's documented path; LM Studio + OpenClaw BKC via WSL2 | Vulkan/ROCm flexibility |
| Friction | Low | Higher — more control |
| Best for | Getting running this week | Max model size / batch serving |

**Concrete first-week plan:**
1. Windows: Adrenalin → VGM **96GB** → restart.
2. Install **LM Studio**, pull `gpt-oss-120b` (MXFP4) and a Qwen 3.5 coding model. Start its server.
3. Wire your existing **`local-llm` MCP** / `/local-*` skills to LM Studio's endpoint → offload
   summaries, docs, tests, drafts off your Claude bill.
4. Agents: enable **WSL2 (Ubuntu 24.04)**, install **OpenClaw**, point it at LM Studio
   (`http://localhost:1234/v1`), give it a >50k-context model.
5. Hermes: run the model in Ollama/LM Studio, point Hermes Agent at the local endpoint.

---

## Caveats & open questions
- **NPU/Lemonade/GAIA: unproven for LLM inference.** The iGPU does the work today.
- **AMD's OpenClaw numbers are vendor best-case** (45 tok/s, 260K ctx, 6 agents — verified 2-1).
- **No verified Llama 70B or dense-Qwen numbers** surfaced — only gpt-oss-120b and Qwen 3.5 35B
  A3B are solidly benchmarked. Benchmark your own models with kyuz0's toolbox.
- **Everything is fast-moving** (ROCm, llama.cpp, OpenClaw v0.x, Hermes v0.2.0, DMR) — numbers
  will drift.
- **Real-world API-bill savings not independently measured** — tooling confirmed, savings figure
  not published for this hardware.

### Open questions worth a follow-up research pass
1. Can the XDNA 2 NPU accelerate/offload LLM inference, and does Lemonade/GAIA beat the
   iGPU-only llama.cpp path?
2. Verified tok/sec for Llama 70B and Qwen dense/MoE variants on this exact 128GB APU.
3. Measured real-world API-bill reduction + quality trade-off via mcp-local-llm / ANTHROPIC_BASE_URL.
4. Most-reliable Linux config recipe (distro, kernel, ROCm version) for max usable model size.
