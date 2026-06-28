---
name: check
description: "Run the full quality pipeline: lint, typecheck, and tests. Triggers on 'check', 'run checks', 'quality check', 'ci check'."
version: 0.1.0
---

# /check

Run the full quality pipeline for Batch Creative Studio.

> Note: these commands assume the project has been scaffolded (`package.json`, Biome, TypeScript, and Vitest installed). On a fresh repo they activate once `pnpm install` and the toolchain configs are in place.

## Steps

1. **Lint**

   Run: `pnpm exec biome check .`

2. **Type Check**

   Run: `pnpm exec tsc --noEmit`

3. **Tests**

   Run: `pnpm exec vitest run`

4. **Report**

   Summarize results:
   - Lint: pass/fail + issue count
   - Type check: pass/fail + error count
   - Tests: pass/fail + test count

   If any step fails, stop and report the failure. Do not proceed to the next step.
