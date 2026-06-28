import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Batch Creative Studio",
  description:
    "Batch generation of styled social posts from product images, conditioned on a reference style.",
};

/**
 * Root layout (component C1, frontend).
 *
 * The editorial visual language lives in `app/globals.css` (white background,
 * charcoal text, system sans-serif, ALL-CAPS labels, thin separators). This
 * Server Component is the static shell; interactive surfaces hydrate as Client
 * Components composed in `app/page.tsx`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          attributes like `data-gr-ext-installed` onto <body> before React
          hydrates, which is harmless but otherwise logs a hydration mismatch. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
