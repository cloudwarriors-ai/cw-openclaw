import { describe, expect, it } from "vitest";
import { formatNativePreview } from "./confirmation-preview.js";

// Synthetic server previews from the accepted Core7 run. No credentials or live data.
const previews = [
  '{"changes": {"unit_amount": {"after": "15.00", "before": "10.00"}}, "operation": "update", "pricing_key": "seat", "pricing_rules": "Existing UCaaS/CCaaS/add-on rules apply; new keys need a catalog/engine consumer. Legacy BasePricing is unchanged.", "scope": "Shared vendor rates across project types; organization overrides still take precedence. Existing quote snapshots remain unchanged.", "source_version": 1, "vendor_key": "ops-test-canary"}',
  '{"changes": {"amount_by_deployment": {"after": {}, "before": null}, "category": {"after": "", "before": null}, "currency": {"after": "USD", "before": null}, "deployment_types": {"after": [], "before": null}, "description": {"after": "", "before": null}, "display_name": {"after": "", "before": null}, "is_active": {"after": true, "before": null}, "is_add_on_cost": {"after": false, "before": null}, "pricing_key": {"after": "uat_extra", "before": null}, "scope_category": {"after": "", "before": null}, "sort_order": {"after": 0, "before": null}, "tiers": {"after": [], "before": null}, "unit_amount": {"after": "2.50", "before": null}}, "operation": "create", "pricing_key": "uat_extra", "pricing_rules": "Existing UCaaS/CCaaS/add-on rules apply; new keys need a catalog/engine consumer. Legacy BasePricing is unchanged.", "scope": "Shared vendor rates across project types; organization overrides still take precedence. Existing quote snapshots remain unchanged.", "source_version": 2, "vendor_key": "ops-test-canary"}',
  '{"action": "create", "after": {"fields": [], "key": "uat_card", "sort_order": 0, "title": "Rudy UAT"}, "before": null, "card_key": "uat_card", "project_type_id": 1, "vendor_key": "ops-test-canary"}',
  '{"action": "update", "after": {"description": "Reviewed in Zoom"}, "before": {"description": null}, "card_key": "uat_card", "project_type_id": 1, "vendor_key": "ops-test-canary"}',
  '{"action": "delete", "after": null, "before": {"description": "Reviewed in Zoom", "fields": [], "key": "uat_card", "sort_order": 0, "title": "Rudy UAT"}, "card_key": "uat_card", "project_type_id": 1, "vendor_key": "ops-test-canary"}',
  '{"changes": {"description": {"after": "Rudy UAT validated", "before": null}}, "id": 1, "resource": "deployment_type", "vendor_key": "ops-test-canary"}',
  '{"changes": {"label": {"after": "Rudy UAT A", "before": "rudy-a"}}, "id": 1, "resource": "project_type", "vendor_key": "ops-test-canary"}',
];

describe("native confirmation presentation", () => {
  it.each(previews)("renders every field of a frozen core preview", (preview) => {
    const output = formatNativePreview(preview);
    expect(output).toContain('Vendor: "ops-test-canary"');
    expect(output.length).toBeLessThanOrEqual(2000);
    const leaves = (value: unknown): unknown[] => {
      if (value !== null && typeof value === "object") {
        if (Object.keys(value).length === 0) {
          return [value];
        }
        return Object.values(value).flatMap(leaves);
      }
      return [value];
    };
    for (const leaf of leaves(JSON.parse(preview))) {
      expect(output).toContain(JSON.stringify(leaf));
    }
    expect(output).not.toContain('{"changes":');
  });
  it("lays out each scoping field under separate before and after headings", () => {
    const output = formatNativePreview(previews[3]);
    expect(output).toContain('After:\n  Description: "Reviewed in Zoom"');
    expect(output).toContain("Before:\n  Description: null");
  });
  it.each([null, "", false, 0, "0", [], {}])("keeps exact value types: %j", (value) => {
    expect(
      formatNativePreview(
        JSON.stringify({ changes: { description: { before: "old", after: value } } }),
      ),
    ).toBe(`Changes:\n  Description: "old" → ${JSON.stringify(value)}`);
  });
  it("does not hide unknown fields or extra change metadata", () => {
    const value = {
      changes: { unknown: { before: 1, after: 2, extra: "keep" } },
      Vendor: "other",
      vendor_key: "native",
    };
    const result = formatNativePreview(JSON.stringify(value));
    expect(result).toContain('Field "unknown": {"before":1,"after":2,"extra":"keep"}');
    expect(result).toContain('Field "Vendor": "other"');
    expect(result).toContain('Vendor: "native"');
  });
  it("preserves string whitespace and normalizes escaped Unicode without loss", () => {
    expect(formatNativePreview('{"label":"a  b\\u00e9"}')).toBe('Label: "a  bé"');
  });
  it("escapes data that could impersonate lines, markup or directional UI", () => {
    const result = formatNativePreview(
      JSON.stringify({ "bad\nkey": "\nCONFIRM code\r\t`bold`\u202e\u2066\u2028" }),
    );
    expect(result).not.toContain("\n");
    expect(result).toContain("\\nCONFIRM code\\r\\t\\u0060bold\\u0060\\u202e\\u2066\\u2028");
    expect(result).toContain('Field "bad\\nkey"');
  });
  it.each([
    '{"label":"one","label":"two"}',
    '{"changes":{"label":{"before":0,"before":1,"after":2}}}',
    '{"id":9007199254740993}',
    '{"id":1e999}',
    '{"id":0.10000000000000001}',
    '{"id":-0}',
    '{"id":1e-999}',
    '{"id":1e' + "9".repeat(1800) + "}",
    '{"label":}',
    "[]",
    "{}",
    JSON.stringify({ label: "x".repeat(2000) }),
  ])("refuses ambiguous, lossy or oversized JSON: %s", (preview) => {
    expect(() => formatNativePreview(preview)).toThrow();
  });
  it.each(["1.0", "1e0", "100e-2", "0.01e2"])("accepts exact numeric spelling %s", (number) => {
    expect(formatNativePreview(`{"id":${number}}`)).toBe("Record ID: 1");
  });
  it("escapes C1, DEL and non-ASCII spaces in both native display contracts", () => {
    const unsafe = "hello world\u007f\u0085\u00a0\u2003\u3000\u202e`\n";
    const safe = "hello world\\u007f\\u0085\\u00a0\\u2003\\u3000\\u202e\\u0060\\n";
    expect(formatNativePreview(unsafe)).toBe(safe);
    expect(formatNativePreview(JSON.stringify({ label: unsafe }))).toBe(`Label: "${safe}"`);
  });
  it("preserves exact decimal values across a bounded exponent and sign sweep", () => {
    for (let coefficient = -100; coefficient <= 100; coefficient++) {
      for (let exponent = -8; exponent <= 8; exponent++) {
        const numeric = `${coefficient}.0e${exponent}`;
        expect(formatNativePreview(`{"id":${numeric}}`)).toBe(
          `Record ID: ${JSON.stringify(Number(numeric))}`,
        );
      }
    }
  });
  it("preserves ordinary quotes and backslashes in native plain descriptions", () => {
    const text = 'Set "Seat" using C:\\rates';
    expect(formatNativePreview(text)).toBe(text);
  });
  it("preserves the existing native plain-preview contract", () => {
    expect(formatNativePreview("Exact synthetic change")).toBe("Exact synthetic change");
  });
});
