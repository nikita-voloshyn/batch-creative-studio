---
name: setup-approach
description: "Change the development approach in CLAUDE.md without re-running /setup-agents. Triggers on 'change approach', 'switch approach', 'setup approach', 'reconfigure approach'."
version: 0.1.0
---

# /setup-approach

Change the development approach for Batch Creative Studio without re-running the full `/setup-agents` dialogue. This skill directly edits the "Development Approach" section in `CLAUDE.md`.

---

## Steps

1. **Read current approach**

   Read `CLAUDE.md` and look for a section starting with `## Development Approach:`.

   - If found: extract the approach name by reading the text after the colon (e.g., `## Development Approach: Iterative + Timeboxing` → current approach is "Iterative + Timeboxing"). Report: "Current approach: **<name>**"
   - Also check for a `### Secondary Approaches` subsection. If present, extract secondary approach names from the approach content headings within that subsection.
   - If not found: report "No approach currently configured."

   The approach name in the heading is always one of the option names from Step 3:
   - Iterative + Timeboxing
   - Shape Up
   - TDD-First
   - Trunk-Based
   - YAGNI/KISS
   - Custom

2. **Load approach reference**

   Read `docs/approaches-reference.md`.

   - If the file does not exist: stop and report "Approach reference file not found. Run `/setup-agents` to generate it." Do not proceed.

3. **Present options**

   Show all 5 approaches with a one-line description. Mark the current selection (if any):

   ```
   Development Approaches (select 1-3, first is primary):

   1. Iterative + Timeboxing — Ship working increments every 1-3 days
   2. Shape Up — 6-week cycles, 2-week cooldown, appetites not estimates
   3. TDD-First — Tests before implementation, coverage as quality signal
   4. Trunk-Based — Single main branch, short-lived branches, feature flags
   5. YAGNI/KISS — Build the minimum, refactor on second similar case
   6. Custom — (only if a custom approach exists in the reference file)
   7. None — Remove all approach sections entirely

   Current: <primary name> [+ secondary names, or "none"]
   ```

   Only show option 6 (Custom) if `docs/approaches-reference.md` contains a `## Custom` section. If no custom approach has been defined, show options 1-5 and 7 (None) only.

   The developer may select 1 to 3 approaches. The first selected is the **primary** (sets cadence and phase structure). Additional selections are secondary (layer rules on top).

   Wait for the developer to select. Do NOT proceed to Step 3a until they respond.

3a. **Conflict check** (run this before anything else after the developer selects)

   Check the selected combination against the conflict matrix:

   | Pair | Conflict |
   |------|----------|
   | Iterative + Timeboxing + Shape Up | Cadence conflict: 1-3 day cycles vs 6-week cycles |

   If the developer selected a conflicting pair, you MUST stop and warn before proceeding:

   > "⚠️ Conflict: Iterative + Timeboxing (1-3 day cycles) and Shape Up (6-week cycles) have incompatible cadences. Please drop one, or type 'confirm' to proceed anyway with awareness of the conflict."

   Wait for the developer to respond. Do NOT proceed to Step 4 until they either drop an approach or explicitly confirm the conflict. This is a hard gate.

   If no conflict: proceed to Step 4 immediately.

4. **Confirm change**

   If the developer selected the same combination as current: "Already using this configuration. No changes needed." Stop.

   Otherwise, confirm before editing:

   ```
   Switch to <primary> [+ <secondary>, ...]? [yes / no]
   ```

   Wait for explicit confirmation. Do not edit without it.

5. **Apply the change**

   **If the developer selected approaches (1-5):**

   Read the matching sections from `docs/approaches-reference.md`. Each section starts at `## <Approach Name>` (e.g., `## Iterative + Timeboxing`) and ends before the next `## ` heading (or end of file). Extract the **body content** below the `## ` heading — do not include the reference file's `## ` heading itself.

   Reference file section headings:
   - `## Iterative + Timeboxing`
   - `## Shape Up`
   - `## TDD-First`
   - `## Trunk-Based`
   - `## YAGNI/KISS`
   - `## Custom`

   In `CLAUDE.md`:

   **Primary approach:**
   - Create/maintain the heading `## Development Approach: <approach name>` (e.g., `## Development Approach: Iterative + Timeboxing`). Insert the body content from the reference file below this heading.
   - If an approach section already exists: replace everything from `## Development Approach:` up to (but not including) `### Secondary Approaches` or the next `## ` heading.
   - If no approach section exists: insert before the `## Development Workflow` section. If that section does not exist, append at the end of the file.

   **Secondary approaches (if any):**
   - After the primary approach content, add a subsection with this exact heading: `### Secondary Approaches` (plural, no approach names in the heading — never `### Secondary Approach: <name>`).
   - Follow the heading with this exact precedence note: "The following approaches layer additional rules on top of the primary approach above. Where rules conflict, the primary approach takes precedence."
   - Insert each secondary approach's content from the reference file, separated by `---`.
   - If no secondary approaches were selected, remove the `### Secondary Approaches` subsection if it exists.

   **If the developer selected "None" (6):**

   Remove the entire `## Development Approach: ...` section from `CLAUDE.md` — everything from that heading up to (but not including) the next `## ` heading (including any `### Secondary Approaches` subsection).

6. **Verify**

   Read `CLAUDE.md` and confirm:
   - If approach selected: the `## Development Approach:` heading exists with the correct primary approach name and content
   - If secondary approaches: the `### Secondary Approaches` subsection exists with the correct secondary approach content
   - If "None": no `## Development Approach:` section exists

   Report the result: "Approach set to **<primary>**" [+ " with secondary: **<name1>**, **<name2>**"] or "Approach removed."

---

## Rules

- Only modify `CLAUDE.md`. Do not touch any other files.
- Use the content from `docs/approaches-reference.md` verbatim. Do not summarize or rephrase.
- Always confirm before making changes. This is a hard gate.
- The secondary approaches heading is ALWAYS `### Secondary Approaches` — never `### Secondary Approach: <name>` or any other variation.
- The conflict check (Step 3a) is a hard gate. Never skip it, never proceed to Step 4 without completing it first.
- Maximum 3 approaches total (1 primary + up to 2 secondary).
- If `CLAUDE.md` does not exist, stop and suggest running `/setup-agents` first.
- If `docs/approaches-reference.md` does not exist, stop and suggest running `/setup-agents` first.
