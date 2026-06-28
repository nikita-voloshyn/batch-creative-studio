---
name: changelog
description: "Generate a session changelog from git diff. Triggers on 'changelog', 'what changed', 'session summary', 'diff summary'."
version: 0.1.0
---

# /changelog

Generate a changelog entry for the current session in Batch Creative Studio.

## Steps

1. **Gather changes**

   Run: `git diff --stat HEAD~1..HEAD`

   If no commits yet in this session, use: `git diff --stat`

2. **Categorize changes**

   Group files by type:
   - **Added** — new files
   - **Modified** — changed files
   - **Deleted** — removed files

   Then group by domain:
   - `frontend`: `app/ (client UI)`, `components/**`, SSE client, visual language
   - `backend`: `app/api/**`, orchestrator, retry engine, rate limiter, SSE server stream, blob signing, state store, failover engine
   - `providers`: `lib/providers/**`, adapters, provider config, reference normalization
   - `testing`: `**/*.test.ts`, fixtures, fake provider
   - `docs`: `docs/components/`, `docs/coverage.md`
   - `security-backend`: `docs/security/**`, `SECURITY.md`

3. **Write entry**

   Format as a markdown changelog entry:

   ```markdown
   ## [Session] <YYYY-MM-DD>

   ### Added
   - ...

   ### Changed
   - ...

   ### Fixed
   - ...
   ```

   Focus on the **why**, not the **what**. Describe the purpose of changes, not just file names.

4. **Output**

   Print the changelog entry to the terminal. Do not write to a file unless the user asks.
