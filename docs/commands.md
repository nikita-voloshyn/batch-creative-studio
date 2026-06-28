# Batch Creative Studio — Command Reference

> Quick reference for all available commands in this project. These assume the project has been scaffolded (`pnpm install` plus Biome, TypeScript, and Vitest configured). On the fresh repo they activate once the toolchain is in place.

## Package Manager

| Command | Description |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run the Next.js dev server |
| `pnpm build` | Production build (`next build`) |
| `pnpm start` | Run the production build locally |
| `pnpm audit --audit-level=high` | Audit dependencies for high/critical vulnerabilities |

## Git

| Command | Description |
|---------|-------------|
| `git status` | Show working tree status |
| `git diff` | Show unstaged changes |
| `gh pr create` | Create a pull request |
| `gh pr list` | List open pull requests |

## Skills

| Skill | Description |
|-------|-------------|
| `/check` | Run the full quality pipeline: lint, typecheck, tests |
| `/changelog` | Generate a session changelog from git diff |
| `/phase` | Execute the current phase from the development plan |
| `/deploy-check` | Pre-deployment audit: quality, secrets, deps, build |
| `/plan` | Plan a feature: decompose into tasks with domain assignments |
| `/assign` | Assign agents and skills to a plan's tasks |
| `/execute` | Execute an approved dispatch task by task |
| `/docs` | Maintain documentation coverage |
| `/setup-approach` | Change the development approach in CLAUDE.md |
| `/observability` | Configure OpenTelemetry export to a tracing backend |

## Orchestration

| Step | Skill | Output |
|------|-------|--------|
| 1. Plan | `/plan` | `docs/plans/<feature>-plan.md` |
| 2. Dispatch | `/assign` | `docs/plans/<feature>-dispatch.md` |
| 3. Execute | `/execute` | `docs/plans/<feature>-report.md` |

Flow: `/plan` → `/assign` → review & approve → `/execute`

## Linting

| Command | Description |
|---------|-------------|
| `pnpm exec biome check .` | Lint + format check (read-only) |
| `pnpm exec biome check --write .` | Apply safe lint/format fixes |

## Testing

| Command | Description |
|---------|-------------|
| `pnpm exec vitest run` | Run tests once (CI / non-watch mode) |
| `pnpm exec vitest run --coverage` | Run tests once with coverage |
| `pnpm exec vitest` | Run tests in watch mode |

## Type Check

| Command | Description |
|---------|-------------|
| `pnpm exec tsc --noEmit` | Type-check without emitting output |

## Build & Deploy

| Command | Description |
|---------|-------------|
| `pnpm build` | Build the project (`next build`) |
| `vercel` | Deploy a preview build to Vercel |
| `vercel --prod` | Deploy to production |
