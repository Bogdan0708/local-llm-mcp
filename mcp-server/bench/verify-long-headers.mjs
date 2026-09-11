// Regression check (takes ~5.5 min, CPU only): run with `node bench/verify-long-headers.mjs`.
// Verify: callLocalLLM survives a native-endpoint response whose headers arrive after 320 s.
import http from "node:http";
import { callLocalLLM } from "../lib.js";
const DELAY = 320000;
const srv = http.createServer((req, res) => {
  if (req.url === "/v1/models") { res.setHeader("Content-Type","application/json"); return res.end(JSON.stringify({data:[{id:"slow-model"}]})); }
  setTimeout(() => { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({output:[{type:"message",content:"late but fine"}],stats:{input_tokens:3,total_output_tokens:3}})); }, DELAY);
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
process.env.LM_STUDIO_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.LM_STUDIO_MODEL = "slow-model";
process.env.LOCAL_LLM_TIMEOUT_MS = String(DELAY + 60000);
process.env.LOCAL_LLM_LOG = "/dev/null";
const m0 = performance.now();
try { const r = await callLocalLLM("sys", "user", { tool: "verify" }); console.log(`PASS mono=${((performance.now()-m0)/1000).toFixed(0)}s text=${JSON.stringify(r.text)}`); }
catch (e) { console.log(`FAIL mono=${((performance.now()-m0)/1000).toFixed(0)}s ${e.message}`); }
srv.close(); lmDispatcherClose(); 
function lmDispatcherClose(){ process.exit(0); }
