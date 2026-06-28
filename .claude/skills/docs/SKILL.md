---
name: docs
description: "Maintain project documentation coverage: audit all components, update specific docs, or check coverage status. Triggers on 'docs audit', 'update docs', 'docs status', 'documentation coverage'."
version: 0.1.0
---

# /docs

Maintain project documentation coverage. Every component should be documented so other agents can read docs instead of analyzing source code.

Three operations — Claude detects which one you want from your input, or asks if unclear:

- **`/docs audit`** — Full scan: discover all components, create or update their docs, rebuild the coverage registry
- **`/docs update <path>`** — Update docs for a single source path
- **`/docs status`** — Check coverage health without making any changes

---

## /docs audit

Full scan of the project. Creates or updates all component docs and rebuilds the coverage registry.

### Steps

1. **Read existing registry.** Read `docs/coverage.md` if it exists. If it does not exist, start with an empty registry.

2. **Determine component scope.** Read all agent definitions in `agents/` and extract the `Owns` list from each agent's Domain section. Skip the docs agent itself (`name: docs`) — it owns `docs/components/` and `docs/coverage.md` which are documentation output, not source to be documented. The remaining owned paths define which source files need documentation.

3. **Enumerate source files.** For each owned path, list all files. Exclude:
   - Test files: `*.test.*`, `*.spec.*`, `__tests__/`
   - Generated output: `dist/`, `build/`, `.cache/`
   - Lock files and dependency directories: `*.lock`, `*.lock.json`, `node_modules/`
   - Documentation output: `docs/`, `docs/**`

4. **Check status for each file.** For every source file:
   - Run `git log -1 --format="%ad" --date=short -- <path>` to get its last modification date
   - Look up the file in the existing registry to determine its current status

5. **Process each file by status:**
   - **`Current`** — skip, no changes needed
   - **`Stale`** — read the existing doc file and the source file; update only the sections that reflect the source changes
   - **`Missing`** — read the source file, infer the component's purpose and interface, write a new doc file

6. **Write doc files.** Save to `docs/components/<slug>.md`. The slug is derived from the source path: lowercase, path separators and spaces replaced with hyphens, special characters removed, truncated to 60 characters. If truncation occurs or the slug already exists for a different source path, append 6 hex characters from a stable hash of the full source path to avoid collisions. Example: `lib/providers/gemini.ts` → `lib-providers-gemini.md`; a long path that collides → `lib-very-long-path-to-component-tha-a1b2c3.md`.

   Each doc file follows this format:

   ```
   ---
   component: <ComponentName>
   source: <relative/path/to/source>
   agent: <owning-agent-name>
   updated: YYYY-MM-DD
   ---

   # <ComponentName>

   ## Purpose
   <1-3 sentences: what this component does and why it exists.>

   ## Public Interface
   <Main exported functions, classes, endpoints, or CLI commands with signatures and one-line descriptions.>

   ## Inputs and Outputs
   <For each significant operation: what it accepts, what it returns, what it reads or writes, error conditions.>

   ## Dependencies
   <Other components this depends on. Format: - `ComponentName` — `docs/components/<slug>.md` — reason.>

   ## Key Decisions
   <Non-obvious implementation choices and why, over alternatives.>

   ## Known Limitations
   <Anything incomplete, deferred, or intentionally simplified.>
   ```

7. **Rebuild the coverage registry.** After all files are processed, rewrite `docs/coverage.md` from scratch:

   ```
   # Documentation Coverage Registry

   **Last full audit:** YYYY-MM-DD
   **Coverage:** N/T documented (X%)

   ## Registry

   | Component | Source path | Doc file | Last doc update | Source last modified | Status |
   |-----------|-------------|----------|-----------------|----------------------|--------|
   | <name> | `<source>` | `docs/components/<slug>.md` | YYYY-MM-DD | YYYY-MM-DD | Current |
   ```

   Compute each column:
   - **Last doc update:** `git log -1 --format="%ad" --date=short -- docs/components/<slug>.md` (or `—` if file is new and not yet committed)
   - **Source last modified:** `git log -1 --format="%ad" --date=short -- <source-path>`
   - **Status:** `Current` if last doc update >= source last modified; `Stale` if source is newer; `Missing` if no doc file exists

8. **Print summary:**
   ```
   Docs audit complete.
   Created: N  |  Updated: N  |  Skipped (current): N
   Coverage: N/T (X%)
   ```

### Rules
- Never modify source files
- Never write to `docs/plans/`
- Use `git log` for all timestamps — never filesystem mtime
- Write documentation at the abstraction level useful to other agents, not as a source code transcription
- If a source file is too large to understand in a single read, start with its exports and public interface

---

## /docs update <path>

Update documentation for a single source path without running a full audit.

### Steps

1. **Accept the path.** If not provided, ask: "Which source file or directory do you want to document? Provide a path relative to the project root."

2. **Verify the path exists.** If not, report and stop.

3. **Get source modification date.** Run `git log -1 --format="%ad" --date=short -- <path>`.

4. **Look up the path in `docs/coverage.md`:**
   - `Current` — tell the developer the doc is already current, show the doc file path, and ask if they want to force an update
   - `Stale` — proceed to update
   - `Missing` or not in registry — proceed to create

5. **Read source (and existing doc if Stale).** Write or update `docs/components/<slug>.md` following the doc file format from the audit section above.

6. **Update the registry.** Update the corresponding row in `docs/coverage.md`, or append it if not present.

7. **Report:** `Updated docs/components/<slug>.md — Missing → Current` (or `Stale → Current`).

---

## /docs status

Quick coverage summary — no writes.

### Steps

1. **Read `docs/coverage.md`.** If it does not exist, report that no registry exists and suggest running `/docs audit` first. Stop.

2. **Count rows by status:** Current, Stale, Missing.

3. **Print summary:**
   ```
   Documentation Coverage
   Last full audit: YYYY-MM-DD

   Status     | Count |   %
   -----------|-------|----
   Current    |     N |  X%
   Stale      |     N |  X%
   Missing    |     N |  X%

   Stale:
   - <ComponentName> — <source-path> (stale since YYYY-MM-DD)

   Missing:
   - <source-path>

   Run /docs audit to update all, or /docs update <path> for a specific component.
   ```

4. **If all components are Current:** "All N components documented and current."
