# Setup Checklist — Local AI on the HP ZBook Ultra G1a

A numbered, do-it-on-the-laptop guide. Follow top to bottom. Based on `findings.md`
(verified) — vendor best-case numbers are flagged.

> **Path choice:** This checklist follows the **Windows-first** route (AMD's officially
> supported, lowest friction). Linux power-user notes are in §7. Do §1–§5 first; they get you
> a working local model + cost-cutting loop. §6 adds the agents.

---

## 0. Pre-flight (5 min)

- [ ] Confirm the machine: AMD Ryzen AI Max+ 395, 128GB RAM, Radeon 8060S. (Settings → System → About.)
- [ ] Update **AMD Adrenalin** to the latest driver (amd.com/support).
- [ ] Decide your disk budget: models are big — gpt-oss-120b ≈ 59GB, a 35B coding model ≈ 20GB.
      Have **150GB+ free**.

---

## 1. Unlock the unified memory (REQUIRED — 5 min + restart)

By default the iGPU only sees **512MB**. Large models will silently fail to load until you do this.

- [ ] Open **AMD Adrenalin** → **Performance** → **Tuning** → **Variable Graphics Memory (VGM)**.
- [ ] Set VGM to **96GB** (the performance sweet spot; iGPU can reach ~112GB but stay ≤96GB for best speed).
- [ ] **Restart the laptop.**
- [ ] Verify after reboot: Task Manager → Performance → GPU → "Dedicated GPU memory" should now
      show a large value (tens of GB), not 0.5GB.

---

## 2. Install LM Studio (AMD's blessed path — 10 min)

- [ ] Download **LM Studio** from lmstudio.ai and install.
- [ ] In LM Studio settings, confirm the runtime is using the **Vulkan or ROCm (llama.cpp)** backend
      for the Radeon 8060S (not CPU). LM Studio usually auto-detects the iGPU.
- [ ] Download two models to start:
  - [ ] **`gpt-oss-120b` (MXFP4)** — your "highest quality" local model (~59GB, ~51–57 tok/s).
  - [ ] A **Qwen 3.5 coding model** (e.g. a 30–35B class, Q4_K_M) — fast enough for interactive work.
- [ ] Load a model and run a test chat to confirm it generates at a usable speed (watch tok/s in the UI).

### Benchmark your own (optional but recommended)
- [ ] ROCm vs Vulkan is **workload-dependent** — neither always wins. If you care about max
      throughput, try both backends on *your* models. Reference suite:
      https://kyuz0.github.io/amd-strix-halo-toolboxes/

---

## 3. Turn on LM Studio's local server (2 min)

- [ ] In LM Studio → **Developer / Local Server** tab → **Start Server**.
- [ ] Confirm it's listening on **`http://localhost:1234/v1`** (OpenAI-compatible).
- [ ] Test it:
      ```bash
      curl http://localhost:1234/v1/models
      ```
      You should get JSON listing your loaded model.

This one endpoint feeds everything below — Claude delegation, OpenClaw, and Hermes.

---

## 4. Wire local models into Claude Code to cut the bill (15 min)

You already have a `local-llm` MCP server and `/local-*` skills installed. Point them at the
LM Studio endpoint from §3.

### Option A — MCP delegation (recommended, strongest confidentiality)
- [ ] Confirm your existing `local-llm` MCP (`mcp__local-llm__local_ask`, `local_code_review`,
      `local_generate_docs`, `local_generate_tests`) is configured to hit `http://localhost:1234/v1`.
      (Check its config / env for a base-URL setting; update it to the LM Studio endpoint.)
- [ ] Optionally also add **`mcp-local-llm`** (github.com/aplaceforallmystuff/mcp-local-llm) for
      the broader tool set: `local_summarize`, `local_draft`, `local_classify`, `local_extract`,
      `local_transform`, `local_complete`, `local_status`.
- [ ] Adopt the task split:

  | Route to **local** (free) | Keep on **Claude/Codex** (cloud) |
  |---|---|
  | Bulk summarization | Complex reasoning / architecture |
  | Boilerplate / drafts | Novel problem-solving |
  | Extraction / formatting | **Security-sensitive ops** |
  | Simple classification | Final review & decisions |
  | Docs / test generation | |

- [ ] **Confidentiality rule:** anything touching **Primaria tax data or FondEU EU-funds records
      (PII/regulated)** → local model only. Keep only abstract architecture questions on cloud.

### Option B — direct endpoint swap (use when you want a fully-local Claude session)
- [ ] Install **Docker Desktop 4.58.0+** and enable **Docker Model Runner** (exposes an
      Anthropic-compatible Messages API).
- [ ] Run Claude Code against it:
      ```bash
      ANTHROPIC_BASE_URL=http://localhost:12434 claude --model <local-model>
      ```
- [ ] ⚠️ Expect rough edges: small default context windows, possible port-12434 conflicts, and
      WSL mirrored-networking requirements. Not a transparent drop-in for full cloud Claude quality —
      use Option A for day-to-day, Option B when you need zero egress for a whole session.

---

## 5. (Codex) Point OpenAI Codex CLI at local models (optional, 5 min)

- [ ] Codex CLI speaks the OpenAI API — set its base URL / endpoint to **`http://localhost:1234/v1`**
      (LM Studio) and pick your loaded model. Use the same task-split discipline as §4.

---

## 6. Run the agents

### 6a. OpenClaw (AMD's official Best Known Configuration)
- [ ] Enable **WSL2** with **Ubuntu 24.04**:
      ```powershell
      wsl --install -d Ubuntu-24.04
      ```
- [ ] Inside WSL, install **OpenClaw** (per docs.openclaw.ai).
- [ ] Point it at LM Studio: provider id **`lmstudio`**, base URL **`http://localhost:1234/v1`**.
      (LM Studio is a native OpenClaw provider.)
- [ ] Use a model with **>~50k context** — agent tooling eats context fast (e.g. a Qwen 3.5 with
      long context; with your 96GB you can go large).
- [ ] For **fully-local `Memory.md`**: set the `memorysearch` parameter in `openclaw.json` to a
      **local embedding model** (otherwise it defaults to a cloud embedder).
- [ ] Expected (AMD vendor best-case, ~Qwen 3.5 35B A3B): **~45 tok/s, ~260K context, up to 6
      concurrent agents**. Treat as optimistic; measure your own.

### 6b. Nous Hermes Agent
- [ ] Remember: **Hermes Agent does NOT run inference itself** — it just drives an endpoint.
- [ ] Serve a **Hermes model** in LM Studio or Ollama on the iGPU.
- [ ] Install Hermes Agent (hermes-agent.nousresearch.com) anywhere — point its endpoint config at
      your local server (`http://localhost:1234/v1` or your Ollama port).
- [ ] Cost when local: **$0.00 API + ~$0.01–0.05/session electricity**, zero data egress.

---

## 7. Linux power-user path (optional — bigger allocations, more friction)

Only if you want to maximize usable model size or run batch serving.

- [ ] In BIOS, keep **dedicated VRAM reservation tiny (0.5GB)**.
- [ ] Raise the shared **TTM/GTT** limit (default ~50% of RAM):
      ```bash
      # via the amd-ttm utility (value ~= GB):
      sudo amd-ttm --set 100        # ~100GB, then reboot
      # or directly (pages, NOT bytes):
      cat /sys/module/ttm/parameters/pages_limit
      ```
- [ ] ⚠️ Known issues: ROCm GitHub **#5562** — Strix Halo needs `ttm.pages_limit` (not the
      Instinct-class `amdttm.*`); some users hit a **62GB cap bug**. Budget debugging time.
- [ ] Install **ROCm** and/or **Vulkan (RADV)** + **llama.cpp**; benchmark both per model.
- [ ] Ceiling: Linux GTT can address ~110GB vs Windows VGM ~112GB — similar, but Linux gives more
      knobs and flexibility.

---

## 8. Verify the whole loop (10 min)

- [ ] LM Studio server responds: `curl http://localhost:1234/v1/models` ✅
- [ ] A local chat generates at expected tok/s ✅
- [ ] Claude Code can delegate to local via your `local-llm` MCP (run `/local-ask` on a throwaway task) ✅
- [ ] OpenClaw connects to LM Studio and completes a simple agent task ✅
- [ ] (If used) Hermes Agent drives the local endpoint ✅
- [ ] Confidentiality check: confirm no PII/regulated data is being routed to cloud models in your
      default workflow ✅

---

## Reality-check reminders

- **NPU (XDNA 2) / Lemonade / GAIA:** NOT proven for running your big LLMs — the **iGPU** does the
  work today. Don't plan around the NPU.
- **AMD's OpenClaw numbers are vendor best-case** — corroborated but optimistic.
- **No verified Llama-70B / dense-Qwen tok/s** for this exact chip — benchmark your own.
- **Everything moves fast** (ROCm, llama.cpp, LM Studio, OpenClaw v0.x, Hermes v0.2.0, DMR) —
  re-check version-specific steps if something doesn't match.
