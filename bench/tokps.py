#!/usr/bin/env python3
"""Quick LM Studio throughput probe. Usage: python3 tokps.py [model-id]
Prints generation tok/s (thinking off), prompt-processing tok/s, and a tool-call check."""
import json, sys, time, urllib.request
URL="http://127.0.0.1:1234/v1/chat/completions"
M=sys.argv[1] if len(sys.argv)>1 else "qwen/qwen3.6-35b-a3b"
def call(body):
    t=time.time(); req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
    r=json.load(urllib.request.urlopen(req,timeout=600)); return r, time.time()-t
try: ps=open("/sys/class/power_supply/BAT0/status").read().strip()+" "+open("/sys/class/power_supply/BAT0/capacity").read().strip()+"%"
except Exception: ps="?"
print(f"model={M} power={ps}")
r,dt=call({"model":M,"messages":[{"role":"user","content":"Write a detailed 500-word explanation of how systemd socket activation works."}],"max_tokens":600,"temperature":0.3,"reasoning_effort":"none"})
c=r["usage"]["completion_tokens"]; print(f"generation: {c} tok in {dt:.1f}s = {c/dt:.1f} tok/s")
big="\n".join(f"line {i}: the quick brown fox jumps over the lazy dog number {i}" for i in range(220))
r,dt=call({"model":M,"messages":[{"role":"user","content":big+"\n\nReply with the single word OK."}],"max_tokens":5,"temperature":0,"reasoning_effort":"none"})
p=r["usage"]["prompt_tokens"]; print(f"prompt processing: {p} tok in {dt:.1f}s = {p/dt:.0f} tok/s (cold prefix)")
tools=[{"type":"function","function":{"name":"run_shell","description":"Run a shell command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}]
r,dt=call({"model":M,"messages":[{"role":"user","content":"Check if nginx is running."}],"tools":tools,"max_tokens":200,"temperature":0.2,"reasoning_effort":"none"})
tc=r["choices"][0]["message"].get("tool_calls"); print(f"tool call: {'OK '+tc[0]['function']['arguments'] if tc else 'NONE'} ({dt:.1f}s)")
