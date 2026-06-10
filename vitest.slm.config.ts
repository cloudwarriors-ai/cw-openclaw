import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTestWithProjects = (
  baseConfig as {
    test?: {
      testTimeout?: number;
      hookTimeout?: number;
      pool?: "forks" | "threads";
      maxWorkers?: number;
      setupFiles?: string[];
      exclude?: string[];
      projects?: unknown[];
    };
  }
).test ?? { testTimeout: 120_000, hookTimeout: 120_000, pool: "forks", maxWorkers: 4 };
// Drop the root `projects` matrix (test/vitest/vitest.config.ts) — inheriting it
// makes vitest ignore `include` below and run the ENTIRE repo suite, which OOMs
// the slm-gates runner heap. Same drop precedent: test/vitest/vitest.e2e.config.ts.
const { projects: _projects, ...baseTest } = baseTestWithProjects;
const isBunRuntime = typeof Bun !== "undefined";
const include = [
  "extensions/slm-pipeline/**/*.test.ts",
  "extensions/slm-supervisor/**/*.test.ts",
  "packages/memory-server/src/**/*.test.ts",
  "apps/slm-dashboard/src/server/**/*.test.ts",
];
if (!isBunRuntime) {
  include.unshift("extensions/memory-pgvector/**/*.test.ts");
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    setupFiles: [],
    include,
    exclude: [
      ...(baseTest.exclude ?? []),
      "**/*.e2e.test.ts",
      "**/*.live.test.ts",
      ...(isBunRuntime
        ? [
            "extensions/memory-pgvector/**/*.test.ts",
            "apps/slm-dashboard/src/server/gateway-client.test.ts",
          ]
        : []),
    ],
  },
});
