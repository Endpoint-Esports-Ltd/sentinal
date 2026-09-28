#!/usr/bin/env python3
"""Print the `result` (or `error`) of the LAST real JSON document in Orca CLI
output. Orca prints pretty multi-line JSON for mutations, and `check --wait`
streams NDJSON `{"_keepalive":true,...}` lines first (on stderr — merge with
2>&1), so plain `json.load` fails with "Extra data".

Usage: orca … --json 2>&1 | orca-json.py [dotted.path]
Exit 1 when the envelope has ok:false."""
import json, sys

text = sys.stdin.read()
dec = json.JSONDecoder()
docs, i = [], 0
while i < len(text):
    j = text.find("{", i)
    if j < 0:
        break
    try:
        obj, end = dec.raw_decode(text, j)
    except ValueError:
        i = j + 1
        continue
    if isinstance(obj, dict) and not obj.get("_keepalive"):
        docs.append(obj)
    i = end
if not docs:
    sys.exit("no JSON document in input")
env = docs[-1]
out = env.get("result") if env.get("ok", True) else env.get("error")
for key in (sys.argv[1].split(".") if len(sys.argv) > 1 else []):
    out = out.get(key) if isinstance(out, dict) else None
print(json.dumps(out, indent=1))
sys.exit(0 if env.get("ok", True) else 1)
