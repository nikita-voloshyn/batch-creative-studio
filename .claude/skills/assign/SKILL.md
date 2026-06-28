---
name: assign
description: "Assign agents and skills to a plan's tasks, producing docs/plans/<feature>-dispatch.md. Run after /plan."
version: 0.1.0
---

# /assign

Assign agents and execution order for a planned feature in Batch Creative Studio.

## Steps

0. **Read project charter (mandatory first step)**

   Before touching any plan file, read the project charter and current state. Do this every run — never rely on memory from a prior session.

   Charter files:
   - `CLAUDE.md` — architecture rules, approach, agent roster
   - `docs/agentic-system.md` — agent domains, ownership, verification commands

   Long-term state (read if the file exists):
   - `docs/state/decisions.md`, `docs/state/open-questions.md`, `docs/state/glossary.md`

   If `CLAUDE.md` is missing, stop and suggest running `/setup-agents`.

1. **Find plan files**

   List files in `docs/plans/` matching `*-plan.md`.

   - If none found: tell the developer no plans exist and suggest running `/plan` first. Stop.
   - If exactly one found: use it.
   - If multiple found: list them and ask the developer which plan to dispatch. Wait for a response.

2. **Read the plan**

   Read the selected plan file. Extract the task table, dependencies, and domain assignments.

3. **Read agent capabilities**

   Read `docs/agentic-system.md` for the full agent roster and their capabilities.

   Available agents:
   - **Frontend Agent** (`frontend`) — domain: Client UI, uploader, batch grid, SSE client + reconnect, visual language
     - Owns: `app/ (client UI, excluding app/api/)`, `components/**`, `SSE client + reconnect`, `visual language / styling`
     - Forbidden: `app/api/**`, `lib/providers/**`
     - Verification: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`
   - **Backend Agent** (`backend`) — domain: Route Handlers, orchestrator, retry engine, rate limiter, SSE server stream, blob signing, state store, failover engine
     - Owns: `app/api/**`, `job orchestrator`, `retry engine`, `per-provider rate limiter`, `SSE server stream`, `blob upload signing`, `in-memory state store`, `failover engine`
     - Forbidden: `components/**`, `lib/providers/**`
     - Verification: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`, `pnpm exec vitest run`
   - **Providers Agent** (`providers`) — domain: `lib/providers/**` — ImageProvider interface + adapters, provider config, reference normalization
     - Owns: `lib/providers/**`, `Gemini/Cloudflare/Replicate adapters`, `provider/model/quota config`, `reference-image normalization`
     - Forbidden: `app/api/**`, `components/**`
     - Verification: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`, `pnpm exec vitest run`
   - **Testing Agent** (`testing`) — domain: Tests + fake provider for deterministic reliability tests
     - Owns: `**/*.test.ts`, `test fixtures`, `fake/mock ImageProvider`
     - Forbidden: `production source code`
     - Verification: `pnpm exec vitest run`, `pnpm exec vitest run --coverage`, `pnpm exec biome check .`
   - **Docs Agent** (`docs`) — domain: Documentation coverage
     - Owns: `docs/components/`, `docs/coverage.md`
     - Forbidden: `source code`, `docs/plans/`
     - Verification: `git diff --stat docs/components/`
   - **Security (Backend) Agent** (`security-backend`) — domain: Review-only server security (SSRF, input validation, rate limiting, secrets, file-upload safety, logging)
     - Owns: `docs/security/**`, `SECURITY.md`
     - Forbidden: `app/api/** and all production source`
     - Verification: `npx semgrep --config p/owasp-top-ten .`

4. **Read dispatch directives**

   Read `agents/dispatch.md` (i.e. `.claude/agents/dispatch.md`) and follow its directives for assignment logic and conflict resolution.

5. **Research on uncertainty (mandatory gate)**

   Before assigning agents, verify that every non-obvious assignment is grounded in evidence — not guesswork. Trigger research if any of these is true:
   - A task touches a framework/library whose current best practice you are not certain of (Next.js, Vercel Blob, the provider SDKs, Vitest)
   - A task mentions a security-sensitive area (SSRF / outbound fetch, input validation, secrets, rate limiting, file upload) and the `security-backend` agent exists
   - Two or more agents could plausibly own the same task (notably the failover engine in `backend` vs the adapters in `providers`)
   - The task uses tooling or patterns not documented in `docs/components/`

   Research procedure:
   1. **Context7** — `resolve-library-id` → `query-docs` with a specific question derived from the task (e.g. "Next.js Route Handler ReadableStream SSE", "Vercel Blob signed client upload", "Gemini 2.5 Flash Image edit request shape")
   2. **Code reading** — consult `docs/components/`, `docs/coverage.md`, and the files listed in the task's acceptance criteria
   3. **Agent definition** — re-read the candidate agent files in `.claude/agents/` to confirm `owns`/`forbidden` fit the task

   Record each non-trivial finding in the dispatch's `## Notes` section so the decision is auditable. If an uncertainty cannot be resolved, flag the task for the developer in step 8 instead of assigning blindly.

6. **Assign agents and skills**

   For each task in the plan:
   - Assign an agent based on domain match. The agent's `owns` list must cover the task's domain.
   - Assign pre-skills: procedures to run before the task (e.g., reading relevant files, checking prerequisites).
   - Assign post-skills: procedures to run after the task (e.g., running verification commands, updating status).
   - If domain assignment is ambiguous, flag it for developer review.

   Available skills for assignment:
   - `/check` — Run the full quality pipeline: lint, typecheck, tests
   - `/changelog` — Generate a session changelog from git diff
   - `/phase` — Execute the current phase from the development plan
   - `/deploy-check` — Pre-deployment audit: quality, secrets, deps, build
   - `/plan` — Plan a feature: decompose into tasks with domain assignments
   - `/assign` — Assign agents and skills to a plan's tasks
   - `/execute` — Execute an approved dispatch task by task
   - `/docs` — Maintain documentation coverage
   - `/setup-approach` — Change the development approach in CLAUDE.md
   - `/observability` — Configure OpenTelemetry export to a tracing backend

7. **Group tasks by dependency level**

   Organize tasks into execution groups:
   - **Group 1**: tasks with no dependencies (can run independently)
   - **Group 2**: tasks that depend only on Group 1 tasks
   - **Group N**: tasks that depend only on tasks in earlier groups

8. **Present for review**

   Show the full assignment table to the developer:

   ```
   Group 1 (independent)
   | Task | Agent | Pre-skills | Post-skills | Status |
   |------|-------|------------|-------------|--------|

   Group 2 (after Group 1)
   | Task | Agent | Pre-skills | Post-skills | Status |
   |------|-------|------------|-------------|--------|
   ```

   All tasks start with Status: `Pending`.

9. **GATE: Wait for approval**

   Ask the developer to review the assignments. They may:
   - Approve as-is
   - Reassign any task to a different agent
   - Add or remove pre/post-skills
   - Reorder groups

   Do not proceed until the developer explicitly approves. This is a hard gate.

10. **Flip plan status to Approved**

    Before writing the dispatch, update the plan file: replace `**Status:** Draft` with `**Status:** Approved` in `docs/plans/<slug>-plan.md`. Save the file.

    If the plan file does not contain a `**Status:**` line (older plans), insert `**Status:** Approved` directly under the `# Plan:` heading.

    This flip is the single source of truth for approval. `/execute` cross-checks both the plan and the dispatch.

11. **Save dispatch file**

   On approval, derive the slug from the plan filename (e.g., `my-feature-plan.md` becomes `my-feature`).

   Write `docs/plans/<slug>-dispatch.md` using this format:

   ```markdown
   # Dispatch: <Feature Name>

   **Plan:** `<slug>-plan.md`
   **Date:** <YYYY-MM-DD>
   **Status:** Approved

   ## Execution Order

   ### Group 1 (independent)

   | Task | Agent | Pre-skills | Post-skills | Status |
   |------|-------|------------|-------------|--------|
   | ... | ... | ... | ... | Pending |

   ### Group 2 (after Group 1)

   | Task | Agent | Pre-skills | Post-skills | Status |
   |------|-------|------------|-------------|--------|
   | ... | ... | ... | ... | Pending |

   ## Notes
   - <reasoning for non-obvious agent assignments>
   - <any flagged ambiguities and how they were resolved>
   ```

12. **Confirm**

    Print the path to the saved dispatch file and suggest running `/execute` next.

## Rules

- Step 0 (charter read) runs every time — no exceptions, no caching.
- The only modification allowed on the plan file is flipping `**Status:** Draft` to `**Status:** Approved` in step 10. Task tables, risks, and goal are never edited from here.
- Flag ambiguous assignments for the developer instead of guessing.
- All tasks start with Status: `Pending`. No other initial status is valid.
- Groups define dependency order, not parallelism. Claude runs one session at a time.
- An agent must never be assigned a task outside its `owns` list.
- An agent must never touch files in its `forbidden` list.
- If uncertain about a framework, pattern, or domain split, research via Context7 and the codebase before assigning — never guess. Record the finding in `## Notes`.
