import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./devtools-tools.js";

describe("bh_devtools_db_query read-only guard", () => {
  it("allows a single SELECT", () => {
    expect(assertReadOnlySql("SELECT * FROM users WHERE id = $1")).toBeUndefined();
  });

  it("allows a WITH (CTE) query and tolerates a trailing semicolon", () => {
    expect(assertReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t;")).toBeUndefined();
  });

  it("allows leading whitespace/newlines and is case-insensitive", () => {
    expect(assertReadOnlySql("  \n select 1")).toBeUndefined();
  });

  it("rejects INSERT/UPDATE/DELETE/DROP", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "TRUNCATE t",
    ]) {
      expect(assertReadOnlySql(sql)).toMatch(/read-only/i);
    }
  });

  it("rejects stacked statements (SQL injection via ;)", () => {
    expect(assertReadOnlySql("SELECT 1; DROP TABLE users")).toMatch(/stacked|multiple/i);
  });

  it("rejects empty / non-SQL input", () => {
    expect(assertReadOnlySql("")).toMatch(/read-only/i);
    expect(assertReadOnlySql("   ")).toMatch(/read-only/i);
  });
});
