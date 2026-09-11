---
description: First-pass code review using the local LM Studio model (conserves Claude usage)
---

Use the local_code_review MCP tool for a first-pass review of the code the user provides or references.

Focus: bugs and logic errors, performance issues, code style and best practices. Do NOT delegate security review to the local model — if security-sensitive code is involved, review that aspect yourself.

Rules:
1. Review the local model's findings yourself before presenting them — correct or drop anything wrong, and add issues it missed.
2. Local review output is never sufficient on its own; your review of it is the quality gate.
3. If the local model is unavailable, do the review yourself and say so once. Never retry the local model in a loop.
