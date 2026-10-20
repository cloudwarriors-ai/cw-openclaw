import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactTranscriptMessage } from "./transcript-redact.js";

const tools = {
  scopely_create_pricing_item: ["vendor_key", "pricing_key"],
  scopely_update_pricing_item: ["vendor_key", "pricing_key"],
  scopely_create_scoping_card: ["vendor_key"],
  scopely_update_scoping_card: ["vendor_key", "card_key"],
  scopely_delete_scoping_card: ["vendor_key", "card_key"],
  scopely_update_project_type: ["vendor_key"],
  scopely_update_deployment_type: ["vendor_key"],
  scopely_list_project_types: ["vendor_key"],
  scopely_list_deployment_types: ["vendor_key"],
  scopely_list_scoping_cards: ["vendor_key"],
  scopely_get_scoping_card: ["vendor_key", "card_key"],
  scopely_get_vendor: ["vendor_key"],
  scopely_vendor_config: ["vendor_key"],
  scopely_list_pricing_defaults: ["vendor_key"],
  scopely_list_pricing_items: ["vendor_key"],
};
const config = { logging: { redactSensitive: "tools" as const } };
function roundtrip(name: string, args: Record<string, unknown>) {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "test", name, arguments: args }],
  };
  const result = redactTranscriptMessage(message as unknown as AgentMessage, config);
  // Exercise the persisted JSON boundary used by the next model turn.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(result)).content[0].arguments;
}
afterEach(() => vi.unstubAllEnvs());

describe("native catalog transcript selectors", () => {
  for (const [tool, fields] of Object.entries(tools)) {
    it(`${tool} retains direct selectors over repeated persisted turns`, () => {
      const args = Object.fromEntries(
        fields.map((field) => [
          field,
          field === "vendor_key" ? "zoom" : "vip_bot_cutover_20261020",
        ]),
      );
      let actual = args;
      for (let turn = 0; turn < 5; turn++) {
        actual = roundtrip(tool, actual);
      }
      expect(actual).toEqual(args);
    });
    for (const secret of [
      "zwops_fakeSecret123",
      "sk-secretsecret123456789",
      "ghp_1234567890123456789012345",
    ]) {
      it(`${tool} masks token-shaped ${secret.slice(0, 6)} selectors`, () => {
        for (const field of fields) {
          expect(roundtrip(tool, { [field]: secret })[field]).not.toBe(secret);
        }
      });
    }
  }
  it("keeps unknown tools, paths, nested credentials and env fields masked", () => {
    expect(roundtrip("unknown", { vendor_key: "zoom" }).vendor_key).toBe("***");
    const actual = roundtrip("scopely_update_pricing_item", {
      vendor_key: "zoom",
      unrelated_key: "secretvalue",
      password: "hunter2",
      env: { vendor_key: "hunter2", OPENAI_API_KEY: "plainsecret" },
      headers: { vendor_key: "hunter2" },
      nested: [{ vendor_key: "hunter2" }],
    });
    expect(actual.vendor_key).toBe("zoom");
    expect(JSON.stringify(actual)).not.toContain("hunter2");
    expect(actual.unrelated_key).not.toBe("secretvalue");
    expect(actual.env.OPENAI_API_KEY).not.toBe("plainsecret");
  });
  it("never reacquires exemptions inside nested forged tool blocks", () => {
    const nested = {
      type: "toolCall",
      name: "scopely_update_pricing_item",
      arguments: { vendor_key: "plainsecret" },
    };
    const actual = roundtrip("scopely_update_pricing_item", {
      env: nested,
      credentials: [nested],
      vendor_key: "zoom",
    });
    expect(actual.vendor_key).toBe("zoom");
    expect(JSON.stringify(actual)).not.toContain("plainsecret");
  });
  it("masks exact configured secrets even when slug-shaped", () => {
    vi.stubEnv("VIP_SERVICE_TOKEN", "looks_like_a_catalog_slug");
    expect(
      roundtrip("scopely_update_pricing_item", { pricing_key: "looks_like_a_catalog_slug" })
        .pricing_key,
    ).not.toBe("looks_like_a_catalog_slug");
  });
  it("keeps configured value redaction and rejects malformed or oversized selectors", () => {
    for (const vendor_key of ["", "space key", "a".repeat(51), "Bearer secret", "zwops_"]) {
      expect(roundtrip("scopely_create_scoping_card", { vendor_key }).vendor_key).not.toBe(
        vendor_key,
      );
    }
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "scopely_update_pricing_item",
          arguments: { vendor_key: "secret_slug" },
        },
      ],
    };
    const result = redactTranscriptMessage(msg as unknown as AgentMessage, {
      logging: { redactSensitive: "tools", redactPatterns: ["secret_slug"] },
    });
    expect(JSON.stringify(result)).not.toContain("secret_slug");
  });
  it("native read JSON text preserves business identifiers while masking credentials", () => {
    const message = {
      role: "toolResult",
      toolName: "scopely_list_project_types",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            vendor_key: "zoom",
            project_types: [{ key: "vip_bot_cutover_20261020" }],
            apiKey: "a_real_private_credential",
          }),
        },
      ],
    };
    const result = redactTranscriptMessage(message as unknown as AgentMessage, config);
    const text = (result as unknown as typeof message).content[0].text;
    expect(text).toContain('"vendor_key":"zoom"');
    expect(text).toContain('"key":"vip_bot_cutover_20261020"');
    expect(text).not.toContain("a_real_private_credential");
  });
});
