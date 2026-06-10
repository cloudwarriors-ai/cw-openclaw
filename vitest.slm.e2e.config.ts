import { defineConfig } from "vitest/config";
// Root vitest.e2e.config.ts was deleted when upstream moved configs under
// test/vitest/ (2ccb5cff22); import the moved file directly.
import baseConfig from "./test/vitest/vitest.e2e.config.ts";

const baseTestWithProjects =
  (
    baseConfig as {
      test?: {
        pool?: "forks" | "threads";
        maxWorkers?: number;
        setupFiles?: string[];
        exclude?: string[];
        projects?: unknown[];
      };
    }
  ).test ?? {};
// Drop any inherited `projects` matrix so `include` below stays authoritative.
const { projects: _projects, ...baseTest } = baseTestWithProjects;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["test/slm/**/*.e2e.test.ts"],
    setupFiles: [],
    exclude: [...(baseTest.exclude ?? []), "test/slm/**/*.playwright.e2e.test.ts"],
  },
});
