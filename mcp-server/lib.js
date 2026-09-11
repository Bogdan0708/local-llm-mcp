import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, fetch } from "undici";

// Non-streaming LM Studio responses send no headers until generation finishes.
// undici's default headersTimeout (300 s) silently killed any delegation slower
// than five minutes (verified 2026-09-02: UND_ERR_HEADERS_TIMEOUT at 318 s mono).
// Disable both undici timers; the per-request AbortSignal remains the only bound.
const lmDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class LocalLLMError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.code = code; // offline | model-missing | timeout | http-error | malformed | context-overflow | truncated
  }
}

function numEnv(name, fallback, parse) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = parse(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`local-llm: invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return v;
}

export function getConfig() {
  return {
    url: process.env.LM_STUDIO_URL || "http://localhost:1234",
    model: process.env.LM_STUDIO_MODEL || "qwen/qwen3.8-27b", // bench winner 56.5/60 on 3 runs, 2026-09-02 (was qwen3.6-35b-a3b, 53.0)
    timeoutMs: numEnv("LOCAL_LLM_TIMEOUT_MS", 360000, (s) => parseInt(s, 10)), // qwen3.8-27b tests case runs ~170-210 s; 180 s was too tight
    maxTokens: numEnv("LOCAL_LLM_MAX_TOKENS", 16384, (s) => parseInt(s, 10)),
    temperature: numEnv("LOCAL_LLM_TEMPERATURE", 0.2, parseFloat),
    logPath: process.env.LOCAL_LLM_LOG ||
      path.join(os.homedir(), ".claude", "local-llm-usage.jsonl"),
  };
}

export function logUsage(entry) {
  const row = {
    timestamp: new Date().toISOString(),
    tool: entry.tool,
    model: entry.model,
    status: entry.status,
    prompt_tokens: entry.prompt_tokens ?? null,
    completion_tokens: entry.completion_tokens ?? null,
    duration_ms: entry.duration_ms,
    finish_reason: entry.finish_reason ?? null,
  };
  try {
    fs.appendFileSync(getConfig().logPath, JSON.stringify(row) + "\n");
  } catch (err) {
    // stderr only: the failed logging sink cannot reliably log its own failure
    console.error(`local-llm: usage log write failed: ${err.message}`);
  }
}

export async function preflight(model, { url, budgetMs = 2000 } = {}) {
  const base = url || getConfig().url;
  let res;
  try {
    res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(budgetMs) });
  } catch (err) {
    throw new LocalLLMError("offline", `LM Studio unreachable at ${base}: ${err.message}`);
  }
  if (!res.ok) {
    throw new LocalLLMError("http-error", `/v1/models returned HTTP ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new LocalLLMError("malformed", "/v1/models returned invalid JSON");
  }
  if (!Array.isArray(data.data)) {
    throw new LocalLLMError("malformed", "/v1/models response missing data array");
  }
  const ids = data.data.map((m) => m.id);
  if (!ids.includes(model)) {
    throw new LocalLLMError("model-missing",
      `model "${model}" not in /v1/models (available: ${ids.join(", ") || "none"})`);
  }
}

// Parsing isolated here: Task 8 verifies this shape against the live server.
function extractText(output) {
  return (output || [])
    .filter((item) => item.type === "message")
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : (item.content || [])
            .map((c) => (typeof c === "string" ? c : c.text ?? ""))
            .join(""))
    .join("");
}

export const TOOLS = [
  {
    name: "local_ask",
    description:
      "Delegate a task to the local LM Studio model: coding questions, code or document summaries, commit-message drafts, and data extraction or transformation.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The task for the local model: a coding question, a summary request, a commit-message draft request, or a data extraction/transformation instruction",
        },
        context: {
          type: "string",
          description: "Optional code, diff, or data context for the task",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "local_code_review",
    description: "First-pass code review using the local LM Studio model",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to review" },
        language: { type: "string", description: "Programming language" },
        focus: { type: "string", description: "What to focus on (bugs, performance, style)" },
      },
      required: ["code"],
    },
  },
  {
    name: "local_generate_docs",
    description: "Generate documentation using the local LM Studio model",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to document" },
        style: { type: "string", description: "Documentation style (jsdoc, docstring, markdown)" },
      },
      required: ["code"],
    },
  },
  {
    name: "local_generate_tests",
    description: "Generate unit tests using the local LM Studio model",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to test" },
        framework: { type: "string", description: "Test framework (node:test, jest, pytest, vitest, etc.)" },
      },
      required: ["code"],
    },
  },
];

export function buildPrompts(name, args) {
  switch (name) {
    case "local_ask": {
      return {
        systemPrompt:
          "You are an expert software engineer. Handle the delegated task clearly and concisely: answer coding questions, summarize code or documents, draft commit messages, or extract/transform data exactly as instructed.",
        userPrompt: args.context
          ? `Context:\n${args.context}\n\nTask: ${args.question}`
          : args.question,
      };
    }
    case "local_code_review": {
      const focus = args.focus || "bugs, performance, and style";
      const lang = args.language || "the code";
      return {
        systemPrompt: `You are an expert code reviewer. Review ${lang} code focusing on: ${focus}. Be specific about issues found and suggest fixes.`,
        userPrompt: `Review this code:\n\n${args.code}`,
      };
    }
    case "local_generate_docs": {
      const style = args.style || "appropriate for the language";
      return {
        systemPrompt: `You are a documentation expert. Generate ${style} documentation for the provided code. Be thorough but concise.`,
        userPrompt: `Generate documentation for:\n\n${args.code}`,
      };
    }
    case "local_generate_tests": {
      const framework = args.framework || "appropriate for the language";
      return {
        systemPrompt: `You are a testing expert. Generate comprehensive unit tests using ${framework}. Cover edge cases and common scenarios.`,
        userPrompt: `Generate tests for:\n\n${args.code}`,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let queue = Promise.resolve();

export function callLocalLLM(systemPrompt, userPrompt, { tool, model } = {}) {
  const cfg = getConfig();
  const usedModel = model || cfg.model;
  const started = Date.now();
  const deadline = started + cfg.timeoutMs;

  const attempt = async () => {
    const remaining = () => deadline - Date.now();
    const fail = (code, message) => {
      logUsage({ tool, model: usedModel, status: code, duration_ms: Date.now() - started });
      throw new LocalLLMError(code, message);
    };

    if (remaining() <= 0) fail("timeout", `queue wait exceeded ${cfg.timeoutMs}ms`);
    try {
      await preflight(usedModel, { url: cfg.url, budgetMs: Math.min(2000, remaining()) });
    } catch (err) {
      // Distinguish: if preflight threw "offline" but deadline is exhausted, it's actually a timeout from queue wait
      if (err.code === "offline" && remaining() <= 0) {
        fail("timeout", "deadline exhausted during preflight (includes queue wait)");
      }
      logUsage({ tool, model: usedModel, status: err.code, duration_ms: Date.now() - started });
      throw err;
    }

    const payload = {
      model: usedModel,
      system_prompt: systemPrompt,
      input: userPrompt,
      temperature: cfg.temperature,
      max_output_tokens: cfg.maxTokens,
      reasoning: "off", // live-verified: only the native endpoint honors reasoning-off on 0.4.20
      store: false,
    };

    let res;
    try {
      res = await fetch(`${cfg.url}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, remaining())),
        dispatcher: lmDispatcher,
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError")
        fail("timeout", `no response within ${cfg.timeoutMs}ms of receipt`);
      fail("offline", `request failed: ${err.message}`);
    }

    // Check for reasoning field unsupported error and retry without it
    if (!res.ok && res.status === 400) {
      const bodyText = await res.text().catch(() => "");
      // Defensively parse error body to check for reasoning param error
      let isReasoningError = false;
      try {
        const errorBody = JSON.parse(bodyText);
        if (errorBody.error?.param === "reasoning") {
          isReasoningError = true;
        }
      } catch {
        // Failed to parse JSON or no error.param field; treat as regular error
      }

      if (isReasoningError) {
        // Retry without reasoning field but keep store: false
        const retryPayload = {
          model: usedModel,
          system_prompt: systemPrompt,
          input: userPrompt,
          temperature: cfg.temperature,
          max_output_tokens: cfg.maxTokens,
          store: false,
        };
        try {
          res = await fetch(`${cfg.url}/api/v1/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(retryPayload),
            signal: AbortSignal.timeout(Math.max(1, remaining())),
        dispatcher: lmDispatcher,
          });
        } catch (err) {
          if (err.name === "TimeoutError" || err.name === "AbortError")
            fail("timeout", `no response within ${cfg.timeoutMs}ms of receipt`);
          fail("offline", `request failed on retry: ${err.message}`);
        }
      } else if (/context|token/i.test(bodyText)) {
        fail("context-overflow", `LM Studio 400: ${bodyText.slice(0, 300)}`);
      } else {
        fail("http-error", `LM Studio ${res.status}: ${bodyText.slice(0, 300)}`);
      }
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (res.status === 400 && /context|token/i.test(bodyText))
        fail("context-overflow", `LM Studio 400: ${bodyText.slice(0, 300)}`);
      fail("http-error", `LM Studio ${res.status}: ${bodyText.slice(0, 300)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      fail("malformed", "response was not valid JSON");
    }

    let text, stats, truncated;
    try {
      text = extractText(data.output);
      if (text.length === 0) fail("malformed", "response had no message content");

      stats = data.stats || {};
      // Native responses carry no finish_reason: infer truncation conservatively.
      truncated = (stats.total_output_tokens ?? 0) >= cfg.maxTokens;
    } catch (err) {
      // Catch TypeError or any error from extractText/stats access on malformed shapes
      if (err instanceof LocalLLMError) throw err; // re-throw if it's our fail() LocalLLMError
      fail("malformed", `response shape invalid: ${err.message}`);
    }

    logUsage({
      tool, model: usedModel, status: truncated ? "truncated" : "success",
      prompt_tokens: stats.input_tokens ?? null,
      completion_tokens: stats.total_output_tokens ?? null,
      duration_ms: Date.now() - started,
      finish_reason: truncated ? "length" : null,
    });
    return { text, truncated };
  };

  const run = queue.then(attempt, attempt);
  queue = run.catch(() => {}); // a failed call never blocks the queue
  return run;
}
