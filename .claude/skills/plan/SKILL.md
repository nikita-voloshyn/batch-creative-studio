---
name: plan
description: "Plan a feature: decompose into tasks, assign domains, produce docs/plans/<feature>-plan.md. Use when starting new feature work."
version: 0.1.0
---

# /plan

Plan a new feature for Batch Creative Studio.

## Steps

0. **Read project charter (mandatory first step)**

   Before any dialogue with the developer, read the project charter and current state. Do this every run — never rely on memory from a prior session.

   Charter files (read in order, skip cleanly if any is missing):
   - `CLAUDE.md` — architecture rules, approach, agent roster
   - `docs/agentic-system.md` — agent domains, ownership, verification commands
   - `docs/development-plan.md` — current phase and roadmap

   Long-term state (read if the file exists):
   - `docs/state/decisions.md` — accepted decisions that constrain future work
   - `docs/state/open-questions.md` — unresolved questions from prior plans
   - `docs/state/glossary.md` — project-specific terms and their meaning

   If `CLAUDE.md` is missing, stop and tell the developer: this skill requires the Forgeline-generated workspace. Suggest running `/setup-agents`.

1. **Gather feature description**

   Ask the developer to describe the feature in natural language. Prompt:
   > What feature would you like to plan? Describe it in a few sentences.

   Wait for a response before proceeding.

2. **Re-read narrow context (only if needed)**

   Re-read targeted files when the feature description points at a specific component or domain:
   - `docs/components/<component>.md` — focused docs for the touched component
   - source files explicitly named in the description

   Do not re-read the charter files from Step 0 — they were just read.

3. **Identify relevant agents**

   From the agents list, identify which domains are involved:
   - **Frontend Agent** (`frontend`) — domain: Client UI, uploader, batch grid (progressive tiles), SSE client + reconnect, visual language. Owns: `app/ (client UI, excluding app/api/)`, `components/**`, `SSE client + reconnect`, `visual language / styling`
   - **Backend Agent** (`backend`) — domain: Route Handlers, orchestrator, retry engine, rate limiter, SSE server stream, blob signing, state store, failover engine. Owns: `app/api/**`, `job orchestrator`, `retry engine`, `per-provider rate limiter`, `SSE server stream`, `blob upload signing`, `in-memory state store`, `failover engine`
   - **Providers Agent** (`providers`) — domain: `lib/providers/**` — ImageProvider interface + Gemini/Cloudflare/Replicate adapters, provider config, reference normalization. Owns: `lib/providers/**`, `Gemini/Cloudflare/Replicate adapters`, `provider/model/quota config`, `reference-image normalization`
   - **Testing Agent** (`testing`) — domain: Tests + fake provider for deterministic reliability tests. Owns: `**/*.test.ts`, `test fixtures`, `fake/mock ImageProvider`
   - **Docs Agent** (`docs`) — domain: Documentation coverage. Owns: `docs/components/`, `docs/coverage.md`
   - **Security (Backend) Agent** (`security-backend`) — domain: Review-only server security (SSRF, input validation, rate limiting, secrets, file-upload safety, logging). Owns: `docs/security/**`, `SECURITY.md`

   Select only the agents whose domains overlap with the described feature.

4. **Ask clarifying questions**

   Before decomposing, ask the developer about:
   - Scope boundaries — what is explicitly in and out
   - Edge cases — error handling, empty states, migrations
   - Dependencies — does this depend on other incomplete work
   - Constraints — performance targets, compatibility requirements

   Wait for answers before proceeding. Do not guess.

5. **Research on uncertainty (mandatory gate)**

   After clarifying answers, if you are not confident about any of the following, **research before proposing the breakdown** — do not guess:
   - A framework/library API, migration pattern, or idiomatic structure (Next.js Route Handlers/SSE, Vercel Blob, the provider SDKs, Vitest)
   - A security or performance trade-off for the chosen stack (e.g., SSRF on outbound fetches, rate limiting, backoff tuning)
   - The current state of a component, file, or module touched by the feature
   - Whether a proposed domain split maps cleanly to existing agents (notably the failover engine in `backend` vs the adapters in `providers`)

   Research procedure:
   1. **Context7 first** — `resolve-library-id` → `query-docs` for each library in doubt (Next.js, Vercel Blob, Gemini, Cloudflare Workers AI, Replicate, Vitest). Ask a specific question derived from the uncertainty, not a generic one.
   2. **Read the code** — open `docs/components/`, `docs/coverage.md`, and the specific source files you will touch. Do not rely on memory of the repo.
   3. **Document findings** — in the plan's `## Risks` section, list each uncertainty and what the research concluded. If a risk remains unresolved, flag it explicitly.

   If an uncertainty cannot be resolved via Context7 or code reading, surface it to the developer as an explicit question before proceeding. Never proceed past this step with unresolved ambiguity.

6. **Propose task breakdown**

   Decompose the feature into tasks. Each task must:
   - Fit in a single Claude session
   - Have exactly one domain owner (agent)
   - Include clear acceptance criteria
   - List explicit dependencies on other tasks (or "none")

   **Security review as an explicit task (mandatory trigger check).** Scan the feature description for any of these signals:

   - **AuthN/AuthZ:** login, signup, password, OAuth, JWT, session, cookie, permission, role, RBAC, ACL, admin
   - **Payments / billing:** Stripe, checkout, invoice, refund, charge, card, payout
   - **PII / sensitive data:** SSN, passport, address, phone, DOB, medical, financial, KYC, GDPR
   - **Secrets / credentials:** API key, token, certificate, secret, credential, env var
   - **Shell / external exec / network:** shell out, exec, subprocess, eval, deserialization, file upload, untrusted input, outbound fetch, SSRF, blob URL
   - **Infra / IaC changes:** IAM, role, security group, bucket policy, network policy, ingress, egress

   If any signal matches:
   - **And** a matching security agent exists (here: `security-backend`): add a dedicated task `## N. Security review — backend` owned by `security-backend`, depending on the implementer tasks it reviews. Acceptance criteria: a written finding in `docs/security/backend.md` plus an approval line.
   - **And** no matching security agent exists: add a `## Risks` note recommending the developer add one via `/setup-agents`, and proceed without the security task.

   Present the full breakdown as a table and wait for the developer to confirm or adjust.

7. **Generate slug and write plan**

   Generate a URL-safe slug from the feature name:
   - Lowercase all characters
   - Replace spaces with hyphens
   - Remove all special characters (keep only `a-z`, `0-9`, `-`)
   - Truncate to 40 characters maximum
   - If `docs/plans/<slug>-plan.md` already exists, append `-2`, `-3`, etc.

   Create the directory `docs/plans/` if it does not exist.

   Write `docs/plans/<slug>-plan.md` using this format:

   ```markdown
   # Plan: <Feature Name>

   **Status:** Draft
   **Date:** <YYYY-MM-DD>
   **Author:** <developer> + <primary domain agent>
   **Approach:** Iterative + Timeboxing
   **Phase:** <current phase from development-plan.md>

   ## Goal
   <1-2 sentences describing what this feature achieves>

   ## Tasks
   | # | Task | Domain | Depends on | Timebox | Acceptance criteria |
   |---|------|--------|------------|---------|---------------------|
   | 1 | ... | ... | none | 1–3 days | ... |
   | 2 | ... | ... | 1 | 1–3 days | ... |

   ## Risks
   - <identified risks or unknowns>

   ## Out of scope
   - <items explicitly excluded>
   ```

   `**Status:** Draft` is mandatory — `/execute` refuses to run plans whose status is not `Approved`. The flip to `Approved` happens in `/assign` after the developer's explicit approval gate.

   Because the approach is **Iterative + Timeboxing**, every task carries a "done in N days" timebox (max 3 days). Tasks that do not fit in 3 days must be split into smaller tasks before the plan is written.

8. **Update long-term state (if relevant)**

   If the plan recorded a decision worth preserving across features, append it to `docs/state/decisions.md` as a single dated bullet. If new unresolved questions surfaced, append them to `docs/state/open-questions.md`. Create either file if it does not exist. Do not store transient task details — only durable facts.

9. **Confirm**

   Print the path to the saved plan file and suggest running `/assign` next to assign agents and execution order.

## Rules

- Step 0 (charter read) runs every time — no exceptions, no caching.
- Tasks must fit in one Claude session — if a task is too large, split it.
- Each task has a single domain owner. If a task spans domains, split it.
- Dependencies must be explicit. Use task numbers, not descriptions.
- The plan is human-readable documentation, not machine-parseable config.
- New plans are always written with `**Status:** Draft`. Only `/assign` may flip the status to `Approved`.
- Never proceed past step 1 without a feature description from the developer.
- Never proceed past step 4 without answers to clarifying questions.
- Never proceed past step 5 with an unresolved uncertainty — research via Context7 and the codebase, or ask the developer.
