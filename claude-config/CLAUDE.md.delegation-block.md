## Local model delegation (best-effort)

A local model is available via the local-llm MCP tools (local_ask, local_code_review, local_generate_docs, local_generate_tests). Delegation policy:

- **Delegate to local, announcing but not asking:** test scaffolding/generation, documentation drafts, code summaries, commit-message drafts, data extraction/transformation, boilerplate, first-pass code review.
- **Never delegate:** architecture decisions, debugging, security-sensitive work, anything delivered to a client without review.
- **Quality gate:** review every local output before using it; if inadequate, redo it yourself silently.
- **Fallback:** if the local model is unavailable, do the work yourself and mention it once per session. Never retry in a loop, never block on the local model.
