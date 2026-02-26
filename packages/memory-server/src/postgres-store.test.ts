import { describe, expect, test } from "vitest";

import { resolvePostgresMemoryStoreFromEnv } from "./postgres-store.js";

describe("postgres memory store resolver", () => {
  test("returns null when db url is missing", () => {
    const store = resolvePostgresMemoryStoreFromEnv({});
    expect(store).toBeNull();
  });

  test("returns store when db url is provided", () => {
    const store = resolvePostgresMemoryStoreFromEnv({
      OPENCLAW_MEMORY_SERVER_DB_URL: "postgresql://user:pass@127.0.0.1:5432/testdb",
    });
    expect(store).not.toBeNull();
  });
});
