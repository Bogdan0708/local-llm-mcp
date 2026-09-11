import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { callLocalLLM, buildPrompts } from "../lib.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const [alias, model, caseName] = process.argv.slice(2);
fs.mkdirSync(path.join(here, "results", alias), { recursive: true });
const c = JSON.parse(fs.readFileSync(path.join(here, "cases", `${caseName}.json`), "utf8"));
const { systemPrompt, userPrompt } = buildPrompts(c.tool, c.args);
const started = Date.now();
try {
  const { text, truncated } = await callLocalLLM(systemPrompt, userPrompt, { tool: c.tool, model });
  fs.writeFileSync(path.join(here, "results", alias, `${caseName}.md`), `# ${c.name} — ${alias}\n\nduration_ms: ${Date.now() - started}\ntruncated: ${truncated}\n\n---\n\n${text}\n`);
  console.log(`${alias} ${c.name}: ok ${Date.now() - started}ms truncated=${truncated}`);
} catch (err) { console.log(`${alias} ${c.name}: FAILED ${err.message}`); process.exit(1); }
