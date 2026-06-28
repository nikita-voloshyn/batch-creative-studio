import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration (Task 10, testing agent).
 *
 * - `@/*` path alias mirrors tsconfig.json (`paths: { "@/*": ["./*"] }`) so test
 *   files import production modules exactly as the app does (`@/lib/...`).
 * - Coverage uses the V8 provider (`@vitest/coverage-v8`, Context7-verified for
 *   Vitest 4) and is AIMED at the reliability core + the two tested adapters, so
 *   `pnpm exec vitest run --coverage` reports meaningful numbers for the code
 *   under test rather than the whole app (UI is minimal by design).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, ""),
    },
  },
  test: {
    environment: "node",
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: [
        "lib/orchestrator/**/*.ts",
        "lib/ratelimit/**/*.ts",
        "lib/state/**/*.ts",
        "lib/blob/**/*.ts",
        "lib/providers/errors.ts",
        "lib/providers/gemini.ts",
        "lib/providers/cloudflare.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts", "test/**"],
    },
  },
});
