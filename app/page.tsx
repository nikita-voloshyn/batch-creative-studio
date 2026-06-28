import { StudioShell } from "@/components/StudioShell";

/**
 * Main page (component C1, frontend). Server Component static shell — a small
 * ALL-CAPS masthead and a one-line lede — hosting the interactive client island
 * (`StudioShell`: uploader + params form + Generate). The editorial visual
 * language lives in `app/globals.css`.
 */
export default function Page() {
  return (
    <main className="content">
      <header className="masthead">
        <h1 className="masthead__title">Batch Creative Studio</h1>
        <span className="masthead__meta">SINGLE STYLE · BATCH OF POSTS</span>
      </header>
      <p className="lede section">
        Upload product images and one or two reference images, set the format and brief, then
        generate a cohesive batch of styled social posts.
      </p>
      <StudioShell />
    </main>
  );
}
