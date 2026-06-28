# CLAUDE.md — Batch Creative Studio

## Project Overview

Batch Creative Studio is a Next.js (App Router) + Vercel web app for **batch generation of styled social posts**. A user uploads N product images (1–20) plus 1–2 reference images (style/mood) and gets back N posts in one cohesive visual style, rendered **progressively** over SSE — the first post appears in seconds, not after the whole batch finishes.

The architectural core is a **provider abstraction with a failover chain** (Gemini → Cloudflare Workers AI → optional Replicate), a **retry engine** (exponential backoff + jitter), a **bounded-concurrency worker pool**, and an **SSE stream** for progressive rendering. Reliability (retries, failover, partial-failure handling) and style consistency are first-class requirements. Persistence (Postgres/Neon + KV/Upstash) and a durable queue are deferred to full-product scope. The app is single-user with **no authentication**.

**Single-writer boundary note (load-bearing):** the failover **ENGINE** lives in the `backend` agent's domain and only ever consumes the `ImageProvider` interface; the provider **adapters** (Gemini, Cloudflare, Replicate) live in the `providers` agent's domain under `lib/providers/**`. `backend` must never edit adapter internals, and `providers` must never edit route handlers or the engine. `frontend` owns the client UI and never calls providers or reads secrets. These three implementer domains are disjoint by design.

## Architecture Rules

1. **Agent boundaries:** Each agent owns a specific domain. Do not modify files outside your domain without explicit delegation.
2. **Context7 for best practices:** Always use Context7 (`resolve-library-id` → `query-docs`) to verify current best practices before making decisions about frameworks, libraries, or tooling.
3. **English only:** All generated files, comments, and documentation must be in English.
4. **No assumptions:** If requirements are ambiguous, ask — never guess.
5. **Test before committing:** Run the relevant verification commands from your agent definition before considering work complete.
6. **Consult `docs/` before reading source:** Check `docs/coverage.md` to find a component's documentation file under `docs/components/`. Documented components can be understood from their doc file alone — reading source is a fallback for undocumented or stale components.
7. **Tool stability for prompt caching:** Do not add or remove tools, skills, or MCP servers mid-session. The model's prompt cache invalidates whenever the tool surface changes — start a new session instead of reconfiguring inside one.
8. **Single-writer rule:** For any single task, exactly one implementer agent makes the changes. Other agents may review, research, or advise — they may not write to the same files. If two implementers could plausibly own the work, split the task or pick one and route the rest to review. (See the boundary note above: the failover engine is `backend`, the adapters are `providers` — never split a single task across both as co-writers.)

## Memory protocol

Long-lived facts about this project live on disk, not in chat. Chat is ephemeral — anything that must survive across sessions belongs in `docs/state/`.

| File | Purpose | Who writes |
|------|---------|------------|
| `docs/state/decisions.md` | Accepted decisions that constrain future work (e.g., "we chose in-memory state for MVP because…"). One dated bullet per decision. | `/plan`, `/setup-approach`, any agent on developer request |
| `docs/state/open-questions.md` | Questions surfaced during planning that are not yet resolved. One dated bullet per question, with the plan slug that raised it. | `/plan`, any agent that hits an unresolved boundary |
| `docs/state/glossary.md` | Project-specific terms and their meaning (domain language, internal acronyms). | Maintained by the developer; agents append candidate entries with a `?` prefix |

Rules:

- Skills `/plan`, `/assign`, and `/execute` read this directory in their Step 0.
- Only durable facts go here — task progress lives in `docs/plans/`, not in `docs/state/`.
- Files are append-only by convention. Editing prior bullets requires the developer's explicit go-ahead.
- Create a file the first time it is needed; do not pre-create empty placeholders.

## Tech Stack

- **Language:** TypeScript
- **Framework:** Next.js (App Router) on Vercel — Fluid Compute, streaming Route Handlers, SSE
- **Package manager:** pnpm
- **Test framework:** Vitest
- **Linter / Formatter:** Biome
- **Blob storage:** Vercel Blob (uploads + results)
- **AI providers:** Gemini 2.5 Flash Image / "Nano Banana" (primary) → Cloudflare Workers AI (secondary) → Replicate (optional tertiary), behind the `ImageProvider` abstraction
- **Persistence (full-product only):** Postgres/Neon + KV/Upstash — out of MVP scope
- **Auth:** None (single-user)
- **Deploy:** Vercel — preview per push, production on main

## Agents

| Agent | Domain | Model |
|-------|--------|-------|
| `frontend` | Client UI, uploader, batch grid (progressive tiles), SSE client + reconnect, visual language | sonnet |
| `backend` | Route Handlers, orchestrator, retry engine, rate limiter, SSE server stream, blob signing, state store, failover engine | opus |
| `providers` | `lib/providers/**` — ImageProvider interface + Gemini/Cloudflare/Replicate adapters, provider config, reference normalization | opus |
| `testing` | Tests + fake provider for deterministic reliability tests | sonnet |
| `dispatch` | Task assignment — assign agents and skills to planned tasks | sonnet |
| `reviewer` | Fresh-context post-task review (auto-invoked by `/execute`) | sonnet |
| `docs` | Documentation coverage (`docs/components/`, `docs/coverage.md`) | sonnet |
| `security-backend` | Review-only server security: SSRF, input validation, rate limiting, secrets, file-upload safety, logging | opus |

## Skills

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

## Project Structure

```
app/
  layout.tsx, page.tsx            — Server shell                                  (frontend)
  (client components)             — uploader, params form, batch grid, SSE client (frontend)
  api/
    uploads/route.ts              — signed Vercel Blob upload                      (backend)
    jobs/route.ts                 — create job + items, start orchestrator         (backend)
    jobs/[id]/route.ts            — job snapshot                                   (backend)
    jobs/[id]/stream/route.ts     — SSE event stream                              (backend)
    jobs/[id]/items/[itemId]/retry/route.ts — targeted retry                      (backend)
components/                       — UI: grid, tile, uploader, status badges        (frontend)
lib/
  providers/                      — ImageProvider interface + Gemini/Cloudflare/Replicate adapters (providers)
  orchestrator/                   — job orchestrator, worker pool                  (backend)
  retry/                          — backoff + jitter retry engine                  (backend)
  failover/                       — failover engine over the ImageProvider contract (backend)
  ratelimit/                      — per-provider token bucket                       (backend)
  state/                          — in-memory job/item/attempt store               (backend)
  **/*.test.ts                    — tests + fake provider                          (testing)
docs/                             — agentic-system, plans, components, state, reviews, security
.claude/                         — agents, skills, settings
```

## Commands

- `pnpm install` — Install dependencies
- `pnpm dev` — Run the Next.js dev server
- `pnpm build` — Production build (`next build`)
- `pnpm exec biome check .` — Lint + format check
- `pnpm exec biome check --write .` — Apply safe lint/format fixes
- `pnpm exec tsc --noEmit` — Type check
- `pnpm exec vitest run` — Run tests once (CI mode)
- `pnpm exec vitest` — Run tests in watch mode
- `vercel` / `vercel --prod` — Deploy preview / production

## Development Approach: Iterative + Timeboxing

### Development Approach: Iterative Delivery

**Philosophy:** Ship working increments every 1–3 days. Each cycle has a tangible deliverable.

**Rules:**

1. Phases in `development-plan.md` are 1–3 day cycles, not milestones. Each phase name is a deliverable, not a category.
2. When planning features (`/plan`), define a "done in N days" timebox for each task. Tasks that don't fit in 3 days must be split into smaller tasks.
3. Execution reports must include cycle duration and whether the timebox was met.
4. Prioritize shipping a working increment over perfection. A deployed feature with rough edges beats a polished feature in a branch.
5. At the end of each cycle, the feature must be in a usable (even if incomplete) state. No cycle ends with broken or non-functional code.

**Phase structure in `development-plan.md`:**

```
| # | Phase (Deliverable)              | Status  | Timebox |
|---|----------------------------------|---------|---------|
| 1 | Auth flow (login + signup)       | Pending | 2 days  |
| 2 | Dashboard with data grid         | Pending | 3 days  |
| 3 | User settings page               | Pending | 1 day   |
```

**How to split tasks:** If a task feels like it needs more than 3 days, ask: "What is the smallest slice that delivers value on its own?" Extract that slice as the current cycle and push the rest to subsequent cycles.

## Development Workflow

Feature development follows a structured pipeline:

1. **`/plan`** — Describe a feature, collaboratively decompose into tasks with domain assignments
2. **`/assign`** — Review and approve agent/skill assignments for each task
3. **`/execute`** — Execute tasks one by one, with verification after each. Produces an execution report

All plan, dispatch, and report files are saved in `docs/plans/` as an audit trail. Each skill is opt-in — you can always work directly with agents without the pipeline.
