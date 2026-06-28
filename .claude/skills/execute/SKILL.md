---
name: execute
description: "Execute an approved dispatch plan task by task, producing docs/plans/<feature>-report.md. Run after /assign."
version: 0.1.0
---

# /execute

Execute an approved dispatch plan for Batch Creative Studio.

## Steps

0. **Read project charter (mandatory first step)**

   Before any task execution, read the project charter and current state. Do this every run — never rely on memory from a prior session.

   Charter files:
   - `CLAUDE.md` — architecture rules, approach, agent roster
   - `docs/agentic-system.md` — agent domains, ownership, verification commands

   Long-term state (read if the file exists):
   - `docs/state/decisions.md`, `docs/state/open-questions.md`, `docs/state/glossary.md`

   If `CLAUDE.md` is missing, stop and suggest running `/setup-agents`.

1. **Find dispatch files**

   List files in `docs/plans/` matching `*-dispatch.md`.

   - If none found: tell the developer no dispatch files exist and suggest running `/assign` first. Stop.
   - If exactly one found: use it.
   - If multiple found: list them and ask the developer which dispatch to execute. Wait for a response.

2. **Verify approval (two-level gate)**

   The approval gate is checked on both the dispatch and the plan. Both must be `Approved`.

   a. Read the dispatch file. Check that `Status:` is `Approved`. If not, stop and suggest running `/assign`.

   b. Derive the plan path from the dispatch's `Plan:` field. Read the plan file. Check that the `**Status:**` line is `Approved`. If the plan still says `Draft` (or any non-`Approved` value), stop and report a gate violation — this means the dispatch was edited manually without going through `/assign`. Suggest re-running `/assign`.

   Both checks must pass before proceeding. Do not patch either file from here.

3. **Resume mechanism**

   Scan all tasks in the dispatch file. Find the first task where Status is not `Done` and not `Skipped`.

   - If all tasks are `Done` or `Skipped`: skip to step 5 (quality check).
   - Otherwise: begin execution from that task.

   This enables resuming across sessions if execution was interrupted.

4. **Execute tasks**

   Process groups in order. Within each group, process tasks in table order.

   **Before each group**, re-read both the plan file and the dispatch file. Long-running executions span sessions and groups — the plan's `## Risks` and `## Out of scope`, and the dispatch's `## Notes`, must stay fresh in context. Do not rely on what was read at step 0 or for an earlier group.

   For each task:

   a. **Update status** — Set the task's Status to `In Progress` in the dispatch file. Save the file.

   b. **Log start** — Print: `Starting task <#>: <task description>`

   c. **Run pre-skills** — If the task has pre-skills assigned, follow their procedures inline. Read any required files, check prerequisites.

   d. **Load agent directives** — Read the assigned agent's definition file (`.claude/agents/<agent-name>.md`). Follow its directives, respect its `owns` and `forbidden` boundaries.

   e. **Perform the work** — Execute the task as described in the plan. Stay within the agent's domain.

   f. **Run verification** — Execute the agent's verification commands:
   - `frontend`: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`
   - `backend`: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`, `pnpm exec vitest run`
   - `providers`: `pnpm exec biome check .`, `pnpm exec tsc --noEmit`, `pnpm exec vitest run`
   - `testing`: `pnpm exec vitest run`, `pnpm exec vitest run --coverage`, `pnpm exec biome check .`
   - `docs`: `git diff --stat docs/components/`
   - `security-backend`: `npx semgrep --config p/owasp-top-ten .`

   g. **Run post-skills** — If the task has post-skills assigned, follow their procedures inline.

   h. **Fresh-context review (mandatory for implementer tasks)** — If the task's assigned agent is an implementer (`frontend`, `backend`, `providers`, `testing` — not review-only agents like `security-backend` or `docs`), invoke the `reviewer` agent with the task number and the dispatch path. The reviewer reads `CLAUDE.md`, the plan, the dispatch, and the diff with a fresh context, then writes its findings to `docs/reviews/<slug>-task<N>-review.md`.

   Read the review verdict before continuing:
   - **Approve / Approve with nits** — proceed to step i.
   - **Request changes** — mark the task `In Progress` again, fix the listed findings, then re-run from step e (Perform the work).
   - **Block** — stop execution, set the task's Status to `Failed`, and ask the developer how to proceed (Retry / Skip / Abort) as on a verification failure.

   Skip this step for review-only or research-only tasks where there is no diff to review.

   i. **Update status** — Set the task's Status to `Done` in the dispatch file. Save the file.

   j. **Record files changed** — Note all files created, modified, or deleted during this task.

   **On failure:**
   - Update the task's Status to `Failed` in the dispatch file.
   - Stop execution immediately.
   - Ask the developer: **Retry** / **Skip** / **Abort**
     - Retry: re-run the same task from step 4a.
     - Skip: set Status to `Skipped`, continue to next task.
     - Abort: stop execution entirely, proceed to step 6 (report).

5. **Quality check**

   After all tasks are complete, run the quality pipeline:

   - **Lint:** Run `pnpm exec biome check .`
   - **Type check:** Run `pnpm exec tsc --noEmit`
   - **Tests:** Run `pnpm exec vitest run`

   Record pass/fail results for each step.

6. **Write report**

   Derive the slug from the dispatch filename (e.g., `my-feature-dispatch.md` becomes `my-feature`).

   Write `docs/plans/<slug>-report.md` using this format:

   ```markdown
   # Report: <Feature Name>

   **Plan:** `<slug>-plan.md`
   **Dispatch:** `<slug>-dispatch.md`
   **Date:** <YYYY-MM-DD>
   **Status:** Complete | Partial | Failed

   ## Results
   | # | Task | Agent | Status | Cycle duration | Timebox met? | Files changed | Notes |
   |---|------|-------|--------|----------------|--------------|---------------|-------|
   | 1 | ... | ... | Done | <e.g. 2 days> | yes | `file1.ts`, `file2.ts` | ... |
   | 2 | ... | ... | Skipped | — | — | — | reason |

   ## Quality Check
   - Lint: pass/fail
   - Types: pass/fail/N/A
   - Tests: N/N passing

   ## Summary
   <2-3 sentences describing what was accomplished and any issues encountered>

   ## Follow-up
   - <tasks that surfaced during execution but were out of scope>
   - <tech debt or improvements identified>
   ```

   Because the approach is **Iterative + Timeboxing**, each result row records the cycle duration and whether the task's timebox was met. The feature must be left in a usable (even if incomplete) state — no cycle ends with broken or non-functional code.

   Set the report Status based on task outcomes:
   - **Complete**: all tasks are `Done`
   - **Partial**: some tasks are `Done`, some are `Skipped`
   - **Failed**: any task is `Failed` (execution was aborted)

7. **Confirm**

   Print the path to the saved report file and summarize:
   - Total tasks: N
   - Done: N
   - Skipped: N
   - Failed: N
   - Quality check results

## Rules

- Step 0 (charter read) runs every time — no exceptions, no caching.
- Step 2 enforces a two-level gate: both plan and dispatch must be `Approved`. A dispatch with an unapproved plan is a gate violation and must not run.
- The plan + dispatch are re-read before each task group — long executions drift without this refresh.
- Execution is sequential — one task at a time, one session at a time.
- Task status is persisted in the dispatch file after every change. This enables resume across sessions.
- Failed tasks never auto-retry. The developer must explicitly choose Retry, Skip, or Abort.
- Every task must record the files it changed. This provides an audit trail.
- The report is the single source of truth for what happened during execution.
- Never modify the plan file. Only the dispatch file (status updates) and report file are written.
- Always respect agent boundaries: stay within `owns`, never touch `forbidden`.
