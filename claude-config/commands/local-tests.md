---
description: Generate test drafts using the local LM Studio model (conserves Claude usage)
---

Use the local_generate_tests MCP tool to draft unit tests for the code the user provides or references.

Rules:
1. Generated tests are drafts, never used as-is: review them, fix wrong assertions, then RUN them and report the results before presenting.
2. If the local model is unavailable, write the tests yourself and say so once. Never retry the local model in a loop.
