// Presentation only: execution and audit retain the server's frozen preview.
// Never let a parser silently drop duplicate keys or round a monetary value.
const LABELS: Record<string, string> = {
  vendor_key: "Vendor",
  pricing_key: "Pricing key",
  card_key: "Scoping card",
  project_type_id: "Project type ID",
  project_type: "Project type",
  project_label: "Project label",
  resource: "Resource",
  id: "Record ID",
  operation: "Operation",
  action: "Action",
  changes: "Changes",
  before: "Before",
  after: "After",
  scope: "Scope",
  pricing_rules: "Pricing rules",
  source_version: "Source version",
  unit_amount: "Unit amount",
  description: "Description",
  label: "Label",
  title: "Title",
  key: "Key",
  fields: "Fields",
  sort_order: "Sort order",
  amount_by_deployment: "Amount by deployment",
  category: "Category",
  currency: "Currency",
  deployment_types: "Deployment types",
  display_name: "Display name",
  is_active: "Active",
  is_add_on_cost: "Add-on cost",
  scope_category: "Scope category",
  tiers: "Tiers",
};
const TARGET_KEYS = [
  "vendor_key",
  "resource",
  "project_type",
  "project_label",
  "key",
  "label",
  "id",
  "project_type_id",
  "card_key",
  "pricing_key",
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeControls(text: string): string {
  // Prevent control characters from impersonating card UI. Plain descriptions
  // keep ordinary quotes/backslashes; structured values are JSON-quoted first.
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}`]/gu, (char) => {
    if (char === " ") {
      return char;
    }
    // The Unicode regex supplies exactly one code point per replacement.
    const code = char.codePointAt(0)!;
    if (code < 0x20) {
      return JSON.stringify(char).slice(1, -1);
    }
    if (code <= 0xffff) {
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    const offset = code - 0x10000;
    return `\\u${(0xd800 + (offset >> 10)).toString(16)}\\u${(0xdc00 + (offset & 1023)).toString(16)}`;
  });
}

function visible(value: unknown): string {
  return escapeControls(JSON.stringify(value));
}

function label(key: string): string {
  return Object.hasOwn(LABELS, key) ? LABELS[key] : `Field ${visible(key)}`;
}

function numericValue(token: string): string {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e");
  const fraction = coefficient.split(".")[1]?.length ?? 0;
  const digits = coefficient.replace(".", "").replace(/^-?0+/, "");
  if (!digits) {
    return coefficient.startsWith("-") ? "-0" : "0";
  }
  const trailing = digits.match(/0+$/)?.[0].length ?? 0;
  const significant = trailing ? digits.slice(0, -trailing) : digits;
  return `${coefficient.startsWith("-") && !significant.startsWith("-") ? "-" : ""}${significant}e${BigInt(exponent) - BigInt(fraction) + BigInt(trailing)}`;
}

export function formatNativePreview(summary: string): string {
  if (summary.length > 2000) {
    throw new Error("Native preview is too large.");
  }
  // Native plain summaries are also a supported server contract. JSON-looking
  // input must parse losslessly; it must never silently become plain text.
  if (!/^[\s]*[[{]/.test(summary)) {
    return escapeControls(summary);
  }
  const value: unknown = JSON.parse(summary);
  const normalized = (text: string) =>
    (text.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/gu) ?? [])
      .map((token) =>
        token.startsWith('"')
          ? JSON.stringify(JSON.parse(token))
          : /^-?\d/.test(token)
            ? numericValue(token)
            : token,
      )
      .join(" ");
  if (!record(value) || normalized(JSON.stringify(value)) !== normalized(summary)) {
    throw new Error("Native preview cannot be represented without loss.");
  }
  const keys = [
    ...TARGET_KEYS.filter((key) => Object.hasOwn(value, key)),
    ...Object.keys(value).filter((key) => !TARGET_KEYS.includes(key)),
  ];
  const lines: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (key === "changes" && record(item) && Object.keys(item).length > 0) {
      lines.push("Changes:");
      for (const [field, change] of Object.entries(item)) {
        const pair =
          record(change) &&
          Object.keys(change).length === 2 &&
          Object.hasOwn(change, "before") &&
          Object.hasOwn(change, "after");
        lines.push(
          pair
            ? `  ${label(field)}: ${visible(change.before)} → ${visible(change.after)}`
            : `  ${label(field)}: ${visible(change)}`,
        );
      }
    } else if (
      (key === "before" || key === "after") &&
      record(item) &&
      Object.keys(item).length > 0
    ) {
      lines.push(`${label(key)}:`);
      for (const [field, fieldValue] of Object.entries(item)) {
        lines.push(`  ${label(field)}: ${visible(fieldValue)}`);
      }
    } else {
      lines.push(`${label(key)}: ${visible(item)}`);
    }
  }
  const result = lines.join("\n");
  if (!result || result.length > 2000) {
    throw new Error("Native preview display is too large.");
  }
  return result;
}
