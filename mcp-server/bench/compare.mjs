import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLocalLLM, buildPrompts } from "../lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [alias, model] = process.argv.slice(2);
if (!alias || !model) {
  console.error("usage: node compare.mjs <alias e.g. model_1> <model-id>");
  process.exit(1);
}
const outDir = path.join(here, "results", alias);
fs.mkdirSync(outDir, { recursive: true });
const cases = fs.readdirSync(path.join(here, "cases")).filter((f) => f.endsWith(".json"));

for (const file of cases) {
  const c = JSON.parse(fs.readFileSync(path.join(here, "cases", file), "utf8"));
  const { systemPrompt, userPrompt } = buildPrompts(c.tool, c.args);
  const started = Date.now();
  try {
    const { text, truncated } = await callLocalLLM(systemPrompt, userPrompt, { tool: c.tool, model });
    fs.writeFileSync(path.join(outDir, file.replace(".json", ".md")),
      `# ${c.name} — ${alias}\n\nduration_ms: ${Date.now() - started}\ntruncated: ${truncated}\n\n---\n\n${text}\n`);
    console.log(`${alias} ${c.name}: ok ${Date.now() - started}ms`);
  } catch (err) {
    fs.writeFileSync(path.join(outDir, file.replace(".json", ".md")),
      `# ${c.name} — ${alias}\n\nFAILED: ${err.message}\n`);
    console.log(`${alias} ${c.name}: FAILED ${err.message}`);
  }
}
