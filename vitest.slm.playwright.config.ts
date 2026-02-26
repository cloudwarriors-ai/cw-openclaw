import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ["test/slm/**/*.playwright.e2e.test.ts"],
    setupFiles: [],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/OpenClaw.app/**",
    ],
  },
});
