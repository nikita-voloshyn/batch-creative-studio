import { AboutBuild } from "@/components/AboutBuild";
import { StudioShell } from "@/components/StudioShell";

/**
 * Main page (component C1, frontend). The single deployed URL carries all three
 * submission sections: (1) the working product — the `StudioShell` client island;
 * (2) "How it was built" and (3) "The code" — the static `AboutBuild` server
 * component. The editorial visual language lives in `app/globals.css`.
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

      <section className="section about" aria-labelledby="the-product">
        <span className="about__num">01</span>
        <h2 id="the-product" className="about__title">
          The product
        </h2>
        <p className="about__lead">
          The working app — uploads, batch generation, and progressive results, end to end. Use{" "}
          <strong>Run example batch</strong> for a one-click demo.
        </p>
      </section>
      <StudioShell />

      <AboutBuild />
    </main>
  );
}
