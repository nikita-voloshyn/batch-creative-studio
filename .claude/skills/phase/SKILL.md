---
name: phase
description: "Execute the current phase from the development plan step by step. Triggers on 'phase', 'next phase', 'run phase', 'execute phase'."
version: 0.1.0
---

# /phase

Execute the current development phase for Batch Creative Studio.

## Steps

1. **Check for orchestration pipeline**

   Check if `docs/plans/` directory exists.

   - If it exists and contains a dispatch file with status `Approved` and pending tasks → suggest: "You have an approved dispatch. Run `/execute` to continue."
   - If it exists but has no dispatch files → suggest: "Run `/plan` to create a feature plan, then `/assign` to assign agents."
   - If `docs/plans/` does not exist → proceed to step 2 (legacy phase execution).

2. **Read the plan**

   Read `docs/development-plan.md` and find the first phase with status `Pending` or `In Progress`.

   If all phases are `Done`, report that the plan is complete.

3. **Break into tasks**

   Decompose the phase into concrete tasks. Each task should be:
   - Small enough to complete in one session
   - Independently verifiable
   - Assigned to the appropriate agent by domain

   Present the task list and wait for confirmation.

4. **Execute tasks**

   For each confirmed task:
   1. Identify which agent owns the domain
   2. Execute the task within the agent's scope
   3. Run the agent's verification commands
   4. Mark the task as done

5. **Update the plan**

   After all tasks in the phase are complete:
   - Update the phase status to `Done` in `docs/development-plan.md`
   - Set the next phase to `In Progress`
   - Report what was accomplished

6. **Run /check**

   After completing the phase, follow the `/check` procedure to verify nothing is broken.
