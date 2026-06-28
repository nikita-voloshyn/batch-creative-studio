---
name: observability
description: "Configure OpenTelemetry export from Claude Code to a tracing backend (LangSmith, Langfuse, or Jaeger). Triggers on 'enable tracing', 'setup observability', 'configure otel', 'send traces'."
version: 0.1.0
---

# /observability

Configure OpenTelemetry export from Claude Code sessions in Batch Creative Studio. Claude Code already emits OTLP traces, metrics, and logs natively — this skill writes the configuration that points them at a backend.

## Background

Claude Code emits these spans automatically when `CLAUDE_CODE_ENABLE_TELEMETRY=1` is set:

| Span | What it covers |
|------|----------------|
| `claude_code.interaction` | One developer-facing turn |
| `claude_code.llm_request` | A single model call (token counts, model id, latency) |
| `claude_code.tool` | A tool/skill invocation (name, duration, success) |
| `claude_code.hook` | A hook execution (matcher, exit code) |

Sub-agents launched via the Task tool are nested under their parent automatically — no extra config needed.

## Steps

1. **Choose a backend**

   Ask the developer which backend to target:

   | Backend | Hosting | Cost | OTLP endpoint |
   |---------|---------|------|---------------|
   | LangSmith | SaaS | Paid (free tier exists) | `https://api.smith.langchain.com/otel` |
   | Langfuse Cloud | SaaS | Free tier | `https://cloud.langfuse.com/api/public/otel` |
   | Langfuse self-hosted | Self-host | Free | `<your-host>/api/public/otel` |
   | Jaeger / Tempo / any OTLP collector | Self-host | Free | `<your-collector>:4318` |
   | Disabled | — | — | — |

   If `Disabled`, write nothing and exit with a one-line confirmation.

2. **Collect credentials**

   For SaaS backends, ask for the relevant API key:
   - **LangSmith:** `LANGSMITH_API_KEY`. The OTLP header is `x-api-key: <key>`.
   - **Langfuse Cloud:** `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`. The OTLP header is `Authorization: Basic <base64(public:secret)>`.

   For self-hosted backends, ask only for the endpoint URL. No credentials assumed.

3. **Write `.env.example`**

   Append a tracing block to the project's `.env.example` (create the file if it does not exist). Use this format, filling in only the backend chosen in step 1:

   ```env
   # ---- Claude Code tracing (OpenTelemetry) ----
   CLAUDE_CODE_ENABLE_TELEMETRY=1
   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1

   OTEL_SERVICE_NAME=Batch Creative Studio
   OTEL_RESOURCE_ATTRIBUTES=project=Batch Creative Studio,env=dev

   # Backend: <chosen-backend>
   OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint-from-step-1>
   OTEL_EXPORTER_OTLP_HEADERS=<header-from-step-2>
   ```

   Never write real secret values — only placeholders. The developer fills in the key locally; the real `.env` stays gitignored.

4. **Write `docs/observability.md`**

   Create `docs/observability.md` with the contents below, substituting the chosen backend. This is the operational doc — what spans to look for, how to enable, how to verify.

   ```markdown
   # Observability

   This project exports Claude Code session telemetry over OpenTelemetry to <backend>.

   ## Enable locally

   1. Copy `.env.example` to `.env`
   2. Fill in the credentials block at the bottom
   3. Source the file in your shell before running Claude Code:
      ```sh
      set -a; source .env; set +a
      claude
      ```

   ## Verify it's working

   Run a short Claude Code session, then in <backend> filter by `service.name = Batch Creative Studio`. Expect to see at least one span of each type:

   - `claude_code.interaction` (one per developer turn)
   - `claude_code.llm_request` (one or more per turn)
   - `claude_code.tool` (one per tool/skill invocation)
   - `claude_code.hook` (when hooks fire)

   ## What to look at

   - **Slow turns:** sort `claude_code.interaction` by duration. Drill into the nested `claude_code.llm_request` spans to see whether the cost is model latency, tool latency, or both.
   - **Tool churn:** group `claude_code.tool` spans by `tool.name`. Repeated identical calls inside one turn signal a feedback loop or a missing skill.
   - **Hook failures:** filter `claude_code.hook` by `status_code = ERROR`. Surface broken matchers fast.
   - **Sub-agents:** `task` tool spans contain a child trace per sub-agent. Use the trace tree to see what the sub-agent did and how it ran.

   ## Disable

   Unset `CLAUDE_CODE_ENABLE_TELEMETRY` (or set to `0`). No restart of any service needed.
   ```

5. **Confirm**

   Print:
   - The path to `.env.example` (updated)
   - The path to `docs/observability.md` (created)
   - A one-line reminder: "Fill in credentials in `.env` (gitignored). Restart your shell or `source .env` to apply."

   Suggest: "Run a quick `/check` or any short feature, then look at <backend> to confirm traces arrive."

## Rules

- Never write real secret values into any committed file. Only placeholders and references.
- `.env.example` is appended to, not overwritten — preserve any existing variables.
- If `.env.example` already contains a tracing block (markered by `# ---- Claude Code tracing`), update in place rather than duplicating.
- `docs/observability.md` is overwritten on each run — it is a single source of truth for the current backend, not a history.
- This skill never enables telemetry on a per-session basis. The developer is in control via their local `.env`.
