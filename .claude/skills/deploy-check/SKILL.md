---
name: deploy-check
description: "Pre-deployment audit: verify code quality, secrets, dependencies, and build. Triggers on 'deploy check', 'pre-deploy', 'deployment audit', 'ready to deploy'."
version: 0.1.0
---

# /deploy-check

Pre-deployment audit for Batch Creative Studio.

## Steps

1. **Run /check**

   Execute the full quality pipeline first. If it fails, stop here.

2. **Secrets scan**

   Search for hardcoded secrets:

   ```bash
   grep -Ern 'API_KEY|SECRET|PASSWORD|PRIVATE_KEY|TOKEN|Bearer ' --include='*.ts' --include='*.tsx' --include='*.js' . | grep -v node_modules | grep -v '.env.example' | grep -v '.next'
   ```

   Pay special attention to provider keys (`GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `REPLICATE_API_TOKEN`, `BLOB_READ_WRITE_TOKEN`) — these must be read from env server-side only, never inlined. Report any findings. If secrets are found, **stop and flag**.

3. **Dependency audit**

   Run: `pnpm audit --audit-level=high`

   Report any high or critical vulnerabilities.

4. **Build verification**

   Run: `pnpm build`

   Confirm the Next.js build completes without errors.

5. **Git status**

   Run: `git status`

   Verify:
   - No uncommitted changes
   - No untracked files that should be committed
   - Branch is up to date with remote (note: this repo currently has no remote configured)

6. **Report**

   Summarize the audit:

   | Check | Status |
   |-------|--------|
   | Quality pipeline | Pass/Fail |
   | Secrets scan | Clean/Found |
   | Dependency audit | Clean/Vulnerabilities |
   | Build | Pass/Fail/Skipped |
   | Git status | Clean/Dirty |

   If all checks pass: **Ready to deploy.**
   If any check fails: **Not ready.** List what needs fixing.
