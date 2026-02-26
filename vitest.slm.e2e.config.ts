import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.e2e.config.ts";

const baseTest = (
  baseConfig as {
    test?: {
      pool?: "forks" | "threads";
      maxWorkers?: number;
      setupFiles?: string[];
      exclude?: string[];
    };
  }
).test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["test/slm/**/*.e2e.test.ts"],
    setupFiles: [],
    exclude: [...(baseTest.exclude ?? []), "test/slm/**/*.playwright.e2e.test.ts"],
  },
});
