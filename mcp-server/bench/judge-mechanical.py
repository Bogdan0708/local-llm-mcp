#!/usr/bin/env python3
"""Mechanical checks for a bench results alias: transform CSV vs Decimal reference, and
execution of the generated node:test suite (auto-detects ESM/CJS and the import path).
Usage: python3 judge-mechanical.py <alias e.g. model_6>"""
import json, csv, io, re, os, sys, subprocess, tempfile, shutil
from decimal import Decimal, ROUND_HALF_UP
here = os.path.dirname(os.path.abspath(__file__)); alias = sys.argv[1]
res = lambda c: open(os.path.join(here, "results", alias, f"{c}.md")).read().split("---", 1)[1]
# --- transform
rows = json.loads(json.load(open(os.path.join(here, "cases/transform.json")))["args"]["context"])
r2 = lambda x: Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
ref = {r["name"]: r2(Decimal(str(r["unitPrice"])) * r["qty"]) for r in rows}; ref = {k: (v, r2(v * Decimal("0.19"))) for k, v in ref.items()}
body = re.sub(r"```\w*", "", res("transform")).strip()
prose = [l for l in body.splitlines() if l and "," not in l]
rd = list(csv.DictReader(io.StringIO(body)))
bad = [(x["name"], x["total"], x["vat"], str(ref[x["name"]][0]), str(ref[x["name"]][1])) for x in rd if (Decimal(x["total"]), Decimal(x["vat"])) != ref[x["name"]]]
print(f"transform: rows={len(rd)} header_ok={list(rd[0].keys())==['name','unitPrice','qty','currency','total','vat']} prose_lines={len(prose)} errors={bad}")
# --- tests
t = res("tests"); blocks = re.findall(r"```(?:javascript|js|mjs|cjs|typescript|ts)?\n(.*?)```", t, re.S)
code = max(blocks, key=len) if blocks else t
esm = bool(re.search(r"^\s*import\s", code, re.M))
paths = [p for p in re.findall(r"(?:from\s*|require\()\s*['\"]([^'\"]+)['\"]", code) if not p.startswith("node:") and p not in ("assert", "test")]
path = paths[0] if paths else "./module"
src = json.load(open(os.path.join(here, "cases/tests.json")))["args"]["code"]
d = tempfile.mkdtemp(prefix="bench-tests-")
base = os.path.basename(path); base = base[:-3] if base.endswith(".js") else base
sub = "test" if path.startswith("../") else "."
os.makedirs(os.path.join(d, sub), exist_ok=True)
if esm:
    open(os.path.join(d, "package.json"), "w").write('{"type":"module"}')
    src = src.replace("function groupInvoicesByQuarter", "export function groupInvoicesByQuarter").replace("module.exports = { groupInvoicesByQuarter };", "")
open(os.path.join(d, base + ".js"), "w").write(src)
open(os.path.join(d, sub, "gen.test.js"), "w").write(code)
out = subprocess.run(["node", "--test"], cwd=d, capture_output=True, text=True).stdout + ""
summary = {k: re.search(rf"^# {k} (\d+)", out, re.M).group(1) for k in ("tests", "pass", "fail") if re.search(rf"^# {k} (\d+)", out, re.M)}
names = re.findall(r"^\s*(?:it|test)\(\s*['\"]([^'\"]+)", code, re.M)
print(f"tests: esm={esm} import={path!r} declared={len(names)} result={summary}")
for n in names: print("   -", n)
fails = re.findall(r"^\s*not ok \d+ - (.+)$", out, re.M)
if fails: print("   FAILED:", fails)
err = re.search(r"# (Error.*|.*Cannot find module.*)", out)
if err and not summary.get("pass"): print("   LOAD ERROR:", err.group(1)[:200])
shutil.rmtree(d, ignore_errors=True)
