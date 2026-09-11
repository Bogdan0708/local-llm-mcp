#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, buildPrompts, callLocalLLM, LocalLLMError } from "./lib.js";

const server = new Server(
  { name: "local-llm", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const { systemPrompt, userPrompt } = buildPrompts(name, args);
    const { text, truncated } = await callLocalLLM(systemPrompt, userPrompt, { tool: name });
    const body = truncated
      ? `[TRUNCATED: output hit max_output_tokens. Retry with tighter scope or handle the remainder yourself.]\n\n${text}`
      : text;
    return { content: [{ type: "text", text: body }] };
  } catch (error) {
    const code = error instanceof LocalLLMError ? error.code : "http-error";
    const message = code === "context-overflow"
      ? `Local model context exceeded (context-overflow): ${error.message}. Retry the local model with a tighter scope (less context), or handle the task yourself.`
      : `Local model unavailable (${code}): ${error.message}. Handle the task yourself; do not retry the local model this turn.`;
    return {
      content: [{
        type: "text",
        text: message,
      }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
