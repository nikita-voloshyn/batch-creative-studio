/**
 * About / colophon sections (frontend) — the submission's section 2 ("How it was
 * built") and section 3 ("The code"), rendered on the same deployed page as the
 * product so the single URL carries all three required sections. Static Server
 * Component (no client state), styled with the existing editorial language.
 */

const REPO_URL = "https://github.com/nikita-voloshyn/batch-creative-studio";
const FORGELINE_URL = "https://github.com/nikita-voloshyn/forgeline";

export function AboutBuild() {
  return (
    <>
      <hr />
      <section className="section about" aria-labelledby="how-it-was-built">
        <span className="about__num">02</span>
        <h2 id="how-it-was-built" className="about__title">
          How it was built
        </h2>

        <h3 className="about__sub">How I used AI</h3>
        <p>
          I wrote the tech spec and the architecture first, then{" "}
          <strong>delegated the implementation</strong> to a multi-agent Claude Code workspace — the
          provider adapters, the reliability core (retry · failover · rate-limit · worker pool), the
          SSE stream, the UI, the tests, and the docs — running each task through a{" "}
          <code>/plan → /assign → /execute</code> pipeline with a fresh-context reviewer after every
          task.
        </p>
        <p>
          <strong>I stepped in</strong> on the calls that needed judgment: the product requirements,
          the ownership boundaries, and — repeatedly — the provider strategy, which only got pinned
          down through live testing. Things <strong>broke</strong> in ways the plan didn&apos;t
          predict: WebP uploads silently failed the image step, a <code>sharp</code> dependency hit
          native-build friction and was dropped, and cold-start hangs needed a timeout race.
        </p>
        <p className="about__override">
          <strong>One thing the AI got wrong — and I overrode.</strong> To style a product to the
          reference, the AI&apos;s first solution composited the product and the reference{" "}
          <em>side-by-side</em> into one frame (FLUX.1-Kontext is single-image). It looked clever
          but was unreliable — the model kept ignoring the reference, copying the reference&apos;s{" "}
          <em>objects</em> into the output, or returning a collage. I rejected it and redirected to
          a <strong>vision-to-text</strong> approach: read the reference&apos;s mood once per batch
          with a vision model, then run a product-only edit conditioned on that text. That is what
          shipped. (Separately, the AI&apos;s first chain put Gemini &ldquo;Nano Banana&rdquo;
          first; its free image-generation limit is 0, so I overrode the chain to HuggingFace
          Kontext.)
        </p>

        <h3 className="about__sub">Toolset</h3>
        <ul className="about__list">
          <li>
            <strong>Claude Code</strong> (CLI) on <strong>Claude Opus 4.x</strong> — the primary
            build agent: wrote most of the code, ran the test/build gates, deployed.
          </li>
          <li>
            <strong>
              <a className="link" href={FORGELINE_URL}>
                Forgeline
              </a>
            </strong>{" "}
            — my own Claude Code plugin; its <code>/setup-agents</code> scaffolded the entire
            multi-agent <code>.claude/</code> workspace from the spec.
          </li>
          <li>
            <strong>Agents</strong> — <code>frontend</code> / <code>backend</code> /{" "}
            <code>providers</code> / <code>testing</code> / <code>security-backend</code> under a
            supervisor, plus a fresh-context <code>reviewer</code> and a <code>docs</code> agent —
            each owning one domain.
          </li>
          <li>
            <strong>Skills / commands</strong> — <code>/plan</code>, <code>/assign</code>,{" "}
            <code>/execute</code> (the build pipeline), <code>/check</code> (lint·types·tests),{" "}
            <code>/docs</code> (coverage).
          </li>
          <li>
            <strong>MCP — Context7</strong> — live library-docs verification (Next.js, Vercel Blob,
            the HuggingFace SDK) before committing to an API.
          </li>
          <li>
            <strong>Vercel CLI &amp; GitHub CLI</strong> — deploys + logs, and the PR-per-feature
            history.
          </li>
          <li>
            <strong>Runtime AI (the app itself)</strong> — HuggingFace FLUX.1-Kontext (image edit) +{" "}
            <code>gemma-3-27b-it</code> (reference-mood vision read), with Cloudflare Workers AI as
            the failover.
          </li>
        </ul>

        <h3 className="about__sub">Time</h3>
        <div className="stats">
          <div className="stat">
            <span className="stat__num">~4h</span>
            <span className="stat__label">Total</span>
          </div>
          <div className="stat">
            <span className="stat__num">~1h30</span>
            <span className="stat__label">Hands-on (me)</span>
          </div>
          <div className="stat">
            <span className="stat__num">~2h30</span>
            <span className="stat__label">AI working</span>
          </div>
        </div>
        <p className="about__fine">
          Hands-on = spec, reviewing each task, directing the provider pivots, and debugging
          decisions. AI working = scaffolding, code generation, running the pipeline, and docs.
        </p>
      </section>

      <hr />
      <section className="section about" aria-labelledby="the-code">
        <span className="about__num">03</span>
        <h2 id="the-code" className="about__title">
          The code
        </h2>
        <p>
          Public repository — full PR-by-feature history, the provider abstraction, the retry and
          failover engines, and the docs:
        </p>
        <p>
          <a className="link link--lg" href={REPO_URL}>
            github.com/nikita-voloshyn/batch-creative-studio
          </a>
        </p>
      </section>
    </>
  );
}
