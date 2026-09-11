# Verified Findings — Strix Halo Local AI Research

Each finding was adversarially fact-checked by 3 independent verifier agents.
Vote `3-0` = unanimous confirm; `2-1` = confirmed with one dissent (caveat noted);
killed claims are in the "Refuted" section at the bottom.

---

## Hardware / memory

### [3-0, high] Unified memory is mapped, not partitioned
Strix Halo memory is physically shared — no VRAM-vs-system-RAM speed difference like discrete
GPUs. Real limiter is ~256GB/s LPDDR5X bandwidth, applying equally to carveout VRAM and GTT.
AMD ROCm docs verbatim: *"Because memory is physically shared, there's no performance distinction
like that of discrete GPUs where dedicated VRAM is significantly faster than system memory."*
Source: https://rocm.docs.amd.com/en/latest/how-to/system-optimization/strixhalo.html

### [3-0, high] Default GTT limit is ~50% of total RAM
GTT (system RAM mappable into GPU address space, used by PyTorch / AI workloads) defaults to ~50%
of total system RAM. It's dynamic, not permanently reserved.
Source: ROCm docs (same as above).

### [3-0, high] Linux: shrink BIOS VRAM, raise TTM/GTT
To use the full 128GB: keep BIOS dedicated VRAM tiny (e.g. 0.5GB) and raise the shared TTM/GTT
limit via `/sys/module/ttm/parameters/pages_limit` (pages, not bytes) or the `amd-ttm` utility
(e.g. `amd-ttm --set 100` for ~100GB, requires reboot).
Caveat: ROCm GitHub issue #5562 — Strix Halo needs `ttm.pages_limit` (not Instinct-class
`amdttm.*`); some users hit a 62GB cap bug. Tooling friction, not a method refutation.
Source: ROCm docs.

### [3-0, high] Windows: Variable Graphics Memory (VGM)
VGM is a BIOS-level reallocation set via AMD Adrenalin (Performance > Tuning > Variable Graphics
Memory), requiring restart. Converts system RAM into a single contiguous dedicated VRAM block.
Presets: Default/Medium/High/Custom(75%) for casual/gamer/power/AI-enthusiast.
Sources: AMD VGM FAQ; AMD OpenClaw article.

### [3-0, high] 128GB default exposes only 512MB; VGM up to 96GB (~112GB ceiling)
Default config = 512MB dedicated graphics memory. VGM settable up to 96GB; iGPU can technically
access ~112GB total graphics memory; best performance when workloads stay ≤96GB.
Source: AMD VGM FAQ.

### [3-0, high] Capacity: ~128B params at 4-bit, ~32B at FP16
With up to 96GB allocated, the 128GB part runs 4-bit (Q4_K_M) LLMs/VLMs up to 128B params, or
FP16 models up to 32B (e.g. Gemma 3 27B FP16) on the iGPU.
Source: AMD VGM FAQ; corroborated by AMD "Run up to 128B param LLMs with LM Studio" blog.

---

## Benchmarks

### [3-0, high] gpt-oss-120b is usable at ~50+ tok/sec
gpt-oss-120b (MXFP4, ~116.8B params, ~59GiB): ROCm ~685 tok/s prompt processing / ~51 tok/s
generation; Vulkan ~720 tok/s pp / ~57 tok/s tg. Independent llama.cpp runs cluster tightly
(Vulkan 726.99 pp / 55.57 tg). Fluctuates ±5 tg across builds; the "usable at ~50+ tok/s"
conclusion is robust.
Source: https://kyuz0.github.io/amd-strix-halo-toolboxes/

### [2-1, medium] Vulkan (RADV) often matches/beats ROCm on token generation
e.g. GLM-4.7-Flash-Q8: Vulkan 41.17 tg t/s vs ROCm ~35. Corroborated by thefrontierlab.ai
(+25-32% tg for RADV on Qwen3 MoE).
CAVEAT (why 2-1): the claim's "ROCm wins prompt processing" sub-qualifier is wrong for the cited
datapoint — RADV pp512 (1092) actually BEAT ROCm (931). The tg thesis holds; the pp
generalization is shaky. The stronger "Vulkan beats ROCm across all tasks" was refuted 0-3.
Treat backend choice as workload-dependent.
Source: kyuz0 benchmark suite.

---

## Agents

### [3-0, high] AMD's official OpenClaw Best Known Configuration
AMD publishes a BKC to run OpenClaw on Ryzen AI Max+ via WSL2 (Ubuntu 24.04) on Windows, using
LM Studio (llama.cpp backend) for fully-local LLM provisioning, including local-embedding
Memory.md support (switch default cloud embedding to local via `memorysearch` in `openclaw.json`).
Sources: AMD OpenClaw article; lmstudio.ai/docs/integrations/openclaw; docs.openclaw.ai/providers/lmstudio.

### [2-1, medium] OpenClaw perf on Ryzen AI Max+ (128GB)
Qwen 3.5 35B A3B: ~45 tok/sec, 10,000 input tokens in ~19.5s, up to 260K context window, up to
6 agents concurrently. TechSpot confirms all four figures; Blaine Brown's M1 Ultra test at 262K
got ~44 tok/sec (consistent).
CAVEAT (2-1): AMD vendor/best-case benchmarks — corroborated but not adversarially independent.
Source: AMD OpenClaw article.

### [3-0, high] OpenClaw is endpoint-agnostic
Routes to local LLMs via OpenAI-compatible `/v1/chat/completions`. Native LM Studio support
(provider id `lmstudio`, base URL `http://localhost:1234/v1`). Documented backends: LM Studio,
Ollama, vLLM, SGLang, MLX (mlx_lm.server), LiteLLM, custom OpenAI-style proxies. Needs a model
with >~50k context (example: `qwen/qwen3.5-9b`). Docs call local-only "the strongest privacy path."
Sources: docs.openclaw.ai/gateway/local-models; lmstudio.ai/docs/integrations/openclaw.

### [3-0, high] Hermes Agent does NOT run inference locally itself
Nous Research's Hermes Agent calls external/OpenAI-compatible endpoints (Nous Portal, OpenRouter,
OpenAI, Ollama, vLLM, llama.cpp, LM Studio, any `/v1/chat/completions` server). *"No local GPU is
required for the agent itself."* Six terminal backends (local/Docker/SSH/Singularity/Modal/Daytona).
On the ZBook: run a local LM Studio/Ollama server and point Hermes at it — the Strix Halo serves
the model, not the agent.
Sources: hermes-agent.nousresearch.com/docs/; github.com/NousResearch/hermes-agent README.

### [3-0, medium] Local inference cost: ~$0.01–0.05/session electricity
Running models locally (e.g. via Ollama) incurs zero API cost, only ~$0.01-0.05/session
electricity, with no data leaving the machine (beyond one-time model download) and no telemetry.
Nous cost table: Ollama $0.00 vs Claude ~$0.80/session.
Source: hermes-agent.nousresearch.com/docs/guides/local-ollama-setup.

---

## Claude/Codex integration

### [3-0, high] mcp-local-llm delegation server
MCP server that lets Claude Code delegate routine/mechanical work to a local Ollama model to cut
API costs. Tools: `local_summarize`, `local_draft`, `local_classify`, `local_extract`,
`local_transform`, `local_complete`, `local_status`.
Recommended split: bulk summarization, boilerplate, extraction/formatting, simple classification,
initial drafts → local; complex reasoning, architecture, security-sensitive ops, novel
problem-solving → cloud. *"Claude does the thinking; your local model handles the grunt work."*
Source: https://github.com/aplaceforallmystuff/mcp-local-llm

### [3-0, medium] Claude Code via ANTHROPIC_BASE_URL + Docker Model Runner
Claude Code can point at a local server via `ANTHROPIC_BASE_URL`. Docker Model Runner exposes an
Anthropic-compatible Messages API (`/v1/messages`) as of Docker Desktop 4.58.0 (~Jan 2026).
Example: `ANTHROPIC_BASE_URL=http://localhost:12434 claude --model ...`
CAVEAT: the related "keeps the standard Claude Code experience" claim was refuted (1-2) — port
12434 conflicts, WSL mirrored-networking requirement, small default context windows.
Sources: docker.com/blog/run-claude-code-with-docker/; docs.docker.com/guides/claude-code-model-runner/.

### [3-0, high] Local-only is the strongest privacy path
Zero data egress, no telemetry. Strongest confidentiality option for sensitive code.

---

## Refuted (killed in verification)

### [1-2] "256 GB/s ≈ double Ryzen AI 300 → ~doubles tok/sec; Llama 4 109B needs ~96GB Q4"
The bandwidth figure is real but "roughly doubles tokens/sec throughput" and the specific 96GB
Q4 requirement for Llama 4 109B did not survive verification.
Source: AMD VGM FAQ.

### [1-2] "Docker Model Runner keeps the standard Claude Code experience"
Refuted — local models have small context windows, networking caveats, and don't replicate the
full cloud Claude experience.
Source: docker.com/blog/run-claude-code-with-docker/.

### [0-3] "Vulkan beats ROCm across ALL tested tasks and models"
Strongly refuted — backend choice is workload-dependent; ROCm wins some tasks.
Source: phoronix.com/review/amd-rocm-7-strix-halo.
