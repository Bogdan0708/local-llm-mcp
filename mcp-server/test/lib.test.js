import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig, logUsage, LocalLLMError } from "../lib.js";

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-test-")), "usage.jsonl");
}

beforeEach(() => {
  delete process.env.LOCAL_LLM_TIMEOUT_MS;
  delete process.env.LOCAL_LLM_MAX_TOKENS;
  delete process.env.LM_STUDIO_URL;
  delete process.env.LM_STUDIO_MODEL;
  delete process.env.LOCAL_LLM_TEMPERATURE;
  delete process.env.LOCAL_LLM_LOG;
});

test("getConfig returns spec defaults", () => {
  const c = getConfig();
  assert.equal(c.url, "http://localhost:1234");
  assert.equal(c.model, "qwen/qwen3.8-27b");
  assert.equal(c.timeoutMs, 360000);
  assert.equal(c.maxTokens, 16384);
  assert.equal(c.temperature, 0.2);
});

test("getConfig reads env fresh on each call", () => {
  process.env.LOCAL_LLM_TIMEOUT_MS = "5000";
  assert.equal(getConfig().timeoutMs, 5000);
});

test("getConfig falls back to defaults on invalid numeric env", () => {
  process.env.LOCAL_LLM_TIMEOUT_MS = "banana";
  assert.equal(getConfig().timeoutMs, 360000);
  process.env.LOCAL_LLM_TIMEOUT_MS = "-5";
  assert.equal(getConfig().timeoutMs, 360000);
});

test("logUsage appends one valid JSONL line with all schema fields", () => {
  const logPath = tmpLog();
  process.env.LOCAL_LLM_LOG = logPath;
  logUsage({ tool: "local_ask", model: "m", status: "success",
    prompt_tokens: 10, completion_tokens: 20, duration_ms: 500, finish_reason: null });
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  for (const key of ["timestamp", "tool", "model", "status",
    "prompt_tokens", "completion_tokens", "duration_ms", "finish_reason"]) {
    assert.ok(key in row, `missing field ${key}`);
  }
  assert.equal(row.status, "success");
  assert.ok(!Number.isNaN(Date.parse(row.timestamp)));
});

test("logUsage uses null for unavailable fields on failure rows", () => {
  const logPath = tmpLog();
  process.env.LOCAL_LLM_LOG = logPath;
  logUsage({ tool: "local_ask", model: "m", status: "offline", duration_ms: 12 });
  const row = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(row.prompt_tokens, null);
  assert.equal(row.completion_tokens, null);
  assert.equal(row.finish_reason, null);
});

test("logUsage never throws on unwritable path, warns stderr", () => {
  process.env.LOCAL_LLM_LOG = "/nonexistent-dir/usage.jsonl";
  assert.doesNotThrow(() =>
    logUsage({ tool: "local_ask", model: "m", status: "success", duration_ms: 1 }));
});

test("LocalLLMError carries a status code", () => {
  const e = new LocalLLMError("timeout", "took too long");
  assert.equal(e.code, "timeout");
  assert.match(e.message, /took too long/);
});

import http from "node:http";
import { preflight } from "../lib.js";

function mockLMStudio(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function modelsHandler(ids) {
  return (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    } else res.writeHead(404).end();
  };
}

test("preflight resolves when model is listed", async (t) => {
  const mock = await mockLMStudio(modelsHandler(["qwen/test-model"]));
  t.after(() => mock.close());
  await preflight("qwen/test-model", { url: mock.url, budgetMs: 2000 });
});

test("preflight throws model-missing when model absent", async (t) => {
  const mock = await mockLMStudio(modelsHandler(["other-model"]));
  t.after(() => mock.close());
  await assert.rejects(
    () => preflight("qwen/test-model", { url: mock.url, budgetMs: 2000 }),
    (e) => e.code === "model-missing");
});

test("preflight throws offline when server unreachable", async () => {
  await assert.rejects(
    () => preflight("m", { url: "http://127.0.0.1:1", budgetMs: 2000 }),
    (e) => e.code === "offline");
});

test("preflight throws offline when server exceeds budget", async (t) => {
  const mock = await mockLMStudio((req, res) => setTimeout(() => res.end("{}"), 500));
  t.after(() => mock.close());
  await assert.rejects(
    () => preflight("m", { url: mock.url, budgetMs: 100 }),
    (e) => e.code === "offline");
});

test("preflight throws http-error on non-2xx /v1/models", async (t) => {
  const mock = await mockLMStudio((req, res) => res.writeHead(500).end("boom"));
  t.after(() => mock.close());
  await assert.rejects(
    () => preflight("m", { url: mock.url, budgetMs: 2000 }),
    (e) => e.code === "http-error");
});

test("preflight throws malformed on invalid /v1/models JSON", async (t) => {
  const mock = await mockLMStudio((req, res) => res.end("not json"));
  t.after(() => mock.close());
  await assert.rejects(
    () => preflight("m", { url: mock.url, budgetMs: 2000 }),
    (e) => e.code === "malformed");
});

import { callLocalLLM } from "../lib.js";

function chatHandler(ids, respond) {
  return (req, res) => {
    if (req.url === "/v1/models") return modelsHandler(ids)(req, res);
    if (req.url === "/api/v1/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => respond(JSON.parse(body), res));
    } else res.writeHead(404).end();
  };
}

function okResponse(content, { inputTokens = 5, outputTokens = 7, reasoningTokens = 0 } = {}) {
  return {
    output: [{ type: "message", content }],
    stats: {
      input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      reasoning_output_tokens: reasoningTokens,
    },
  };
}

function useMock(mock) {
  process.env.LM_STUDIO_URL = mock.url;
  process.env.LM_STUDIO_MODEL = "qwen/test-model";
  process.env.LOCAL_LLM_LOG = tmpLog();
}

function lastLogRow() {
  return JSON.parse(
    fs.readFileSync(process.env.LOCAL_LLM_LOG, "utf8").trim().split("\n").at(-1));
}

test("success sends native reasoning-off payload and logs success row", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"], (body, res) => {
    assert.equal(body.model, "qwen/test-model");
    assert.equal(body.system_prompt, "sys");
    assert.equal(body.input, "user");
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_output_tokens, 16384);
    assert.equal(body.reasoning, "off");   // locked reasoning-off control
    assert.equal(body.store, false);
    res.end(JSON.stringify(okResponse("hello")));
  }));
  t.after(() => mock.close());
  useMock(mock);
  const out = await callLocalLLM("sys", "user", { tool: "local_ask" });
  assert.equal(out.text, "hello");
  assert.equal(out.truncated, false);
  const row = lastLogRow();
  assert.equal(row.status, "success");
  assert.equal(row.prompt_tokens, 5);
  assert.equal(row.completion_tokens, 7);
  assert.equal(row.finish_reason, null); // native endpoint has no finish_reason
});

test("output tokens at cap infers truncation with synthetic finish_reason length", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.end(JSON.stringify(okResponse("partial", { outputTokens: 8 })))));
  t.after(() => mock.close());
  useMock(mock);
  process.env.LOCAL_LLM_MAX_TOKENS = "8";
  t.after(() => delete process.env.LOCAL_LLM_MAX_TOKENS);
  const out = await callLocalLLM("sys", "user", { tool: "local_ask" });
  assert.equal(out.truncated, true);
  const row = lastLogRow();
  assert.equal(row.status, "truncated");
  assert.equal(row.finish_reason, "length"); // synthetic: inferred from total_output_tokens >= maxTokens
});

test("chat HTTP 500 throws http-error and logs it", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.writeHead(500).end("boom")));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "http-error");
  assert.equal(lastLogRow().status, "http-error");
});

test("chat HTTP 400 mentioning context throws context-overflow", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.writeHead(400).end(
      JSON.stringify({ error: { message: "context length exceeded" } }))));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "context-overflow");
  assert.equal(lastLogRow().status, "context-overflow");
});

test("response with no message items throws malformed", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.end(JSON.stringify({ output: [], stats: {} }))));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "malformed");
});

test("slow generation throws timeout (distinct from offline)", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => setTimeout(() => res.end(JSON.stringify(okResponse("late"))), 2000)));
  t.after(() => mock.close());
  useMock(mock);
  process.env.LOCAL_LLM_TIMEOUT_MS = "300";
  t.after(() => delete process.env.LOCAL_LLM_TIMEOUT_MS);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "timeout");
  assert.equal(lastLogRow().status, "timeout");
});

test("concurrent calls are serialized FIFO", async (t) => {
  let inFlight = 0, maxInFlight = 0;
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"], (b, res) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; res.end(JSON.stringify(okResponse("ok"))); }, 100);
  }));
  t.after(() => mock.close());
  useMock(mock);
  await Promise.all([
    callLocalLLM("s", "a", { tool: "local_ask" }),
    callLocalLLM("s", "b", { tool: "local_ask" }),
  ]);
  assert.equal(maxInFlight, 1);
});

test("queue wait counts against the timeout deadline", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => setTimeout(() => res.end(JSON.stringify(okResponse("ok"))), 400)));
  t.after(() => mock.close());
  useMock(mock);
  process.env.LOCAL_LLM_TIMEOUT_MS = "500";
  t.after(() => delete process.env.LOCAL_LLM_TIMEOUT_MS);
  const first = callLocalLLM("s", "a", { tool: "local_ask" }); // holds queue ~400ms
  const second = callLocalLLM("s", "b", { tool: "local_ask" }); // ~100ms budget left
  await first;
  await assert.rejects(() => second, (e) => e.code === "timeout");
});

test("response content that is not string nor falsy throws malformed", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.end(JSON.stringify({
      output: [{ type: "message", content: 123 }],
      stats: { input_tokens: 5, total_output_tokens: 7 },
    }))));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "malformed");
  assert.equal(lastLogRow().status, "malformed");
});

test("response body that is JSON null throws malformed", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.end("null")));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "malformed");
  assert.equal(lastLogRow().status, "malformed");
});

test("response output that is not an array throws malformed", async (t) => {
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"],
    (b, res) => res.end(JSON.stringify({
      output: { weird: true },
      stats: { input_tokens: 5, total_output_tokens: 7 },
    }))));
  t.after(() => mock.close());
  useMock(mock);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "malformed");
  assert.equal(lastLogRow().status, "malformed");
});

test("slow /v1/models expiring deadline during preflight throws timeout not offline", async (t) => {
  const slowMock = await mockLMStudio((req, res) => {
    if (req.url === "/v1/models") {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "qwen/test-model" }] }));
      }, 200);
    } else if (req.url === "/api/v1/chat" && req.method === "POST") {
      res.end(JSON.stringify(okResponse("ok")));
    } else res.writeHead(404).end();
  });
  t.after(() => slowMock.close());
  useMock(slowMock);
  process.env.LOCAL_LLM_TIMEOUT_MS = "100";
  t.after(() => delete process.env.LOCAL_LLM_TIMEOUT_MS);
  await assert.rejects(() => callLocalLLM("s", "u", { tool: "local_ask" }),
    (e) => e.code === "timeout");
  assert.equal(lastLogRow().status, "timeout");
});

test("HTTP 400 with reasoning param error retries without reasoning field and logs success", async (t) => {
  const requestBodies = [];
  const mock = await mockLMStudio(chatHandler(["qwen/test-model"], (body, res) => {
    requestBodies.push(body);
    // First request with reasoning: return 400 error about reasoning not supported
    if (body.reasoning) {
      res.writeHead(400);
      res.end(JSON.stringify({
        error: {
          message: "Model 'qwen/qwen3-coder-30b' does not expose reasoning configuration.",
          type: "invalid_request",
          param: "reasoning",
          code: "invalid_value",
        },
      }));
    } else {
      // Retry without reasoning: return success
      res.end(JSON.stringify(okResponse("hello")));
    }
  }));
  t.after(() => mock.close());
  useMock(mock);
  const out = await callLocalLLM("sys", "user", { tool: "local_ask" });
  assert.equal(out.text, "hello");
  assert.equal(out.truncated, false);
  // Verify exactly one JSONL row with success status
  const row = lastLogRow();
  assert.equal(row.status, "success");
  // Verify we made two requests: first with reasoning, second without
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].reasoning, "off");
  assert.equal(requestBodies[0].store, false);
  assert.equal(requestBodies[1].reasoning, undefined);
  assert.equal(requestBodies[1].store, false);
});

import { TOOLS, buildPrompts } from "../lib.js";

test("no tool advertises security anywhere", () => {
  const all = JSON.stringify(TOOLS).toLowerCase();
  assert.ok(!all.includes("security"), "the word 'security' must not appear in tool definitions");
});

test("local_code_review default prompt excludes security", () => {
  const { systemPrompt } = buildPrompts("local_code_review", { code: "x" });
  assert.ok(!systemPrompt.toLowerCase().includes("security"));
  assert.match(systemPrompt, /bugs, performance, and style/);
});

test("local_ask is broadened in tool AND input descriptions", () => {
  const ask = TOOLS.find((t) => t.name === "local_ask");
  for (const text of [ask.description, ask.inputSchema.properties.question.description]) {
    assert.match(text, /summar/i);
    assert.match(text, /commit/i);
    assert.match(text, /transform/i);
  }
});

test("all four tools exist with required fields", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(),
    ["local_ask", "local_code_review", "local_generate_docs", "local_generate_tests"]);
});

test("buildPrompts local_ask includes context when given", () => {
  const { userPrompt } = buildPrompts("local_ask", { question: "q", context: "ctx" });
  assert.match(userPrompt, /ctx/);
  assert.match(userPrompt, /q/);
});
