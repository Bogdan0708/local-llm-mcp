---
description: Generate documentation drafts using the local LM Studio model (conserves Claude usage)
---

Use the local_generate_docs MCP tool to draft documentation for the code the user provides or references.

Rules:
1. The local output is a draft, never final: verify it against the actual code and correct inaccuracies before presenting it.
2. If the local model is unavailable, write the documentation yourself and say so once. Never retry the local model in a loop.
