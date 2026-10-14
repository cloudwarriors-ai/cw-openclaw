import { beforeEach, describe, expect, it, vi } from "vitest";
const stage = vi.hoisted(() => vi.fn());
vi.mock("./ops-write-client.js", () => ({ opsStageWrite: stage }));
import { registerScopingCardTools } from "./scoping-card-tools.js";

type Tool = {
  name: string;
  description: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
};
function buildTools() {
  const tools = new Map<string, Tool>();
  registerScopingCardTools(
    {
      registerTool: (factory: () => Tool) => {
        const tool = factory();
        tools.set(tool.name, tool);
      },
    } as never,
    vi.fn(),
  );
  return tools;
}
describe("scoping card operator adapters", () => {
  beforeEach(() => {
    stage.mockReset();
    stage.mockResolvedValue({ content: [{ type: "text", text: '{"staged":true}' }] });
  });
  it.each(["create", "update", "delete"])(
    "routes %s through the confirmed ops adapter without dropping arguments",
    async (action) => {
      const tool = buildTools().get(`scopely_${action}_scoping_card`)!;
      const args = {
        vendor_key: "ops-test-canary",
        project_type_id: 4,
        card_id: 7,
        title: "New",
        fields: [{ key: "q", label: "Q", field_type: "text" }],
        visibility: { remote: "yes" },
        visibility_condition: { unsupported: true },
      };
      await tool.execute("call", args);
      expect(stage).toHaveBeenCalledExactlyOnceWith(`catalog.scoping_cards.${action}`, args);
      // Unsupported parameters must reach strict backend validation, never disappear.
      expect(stage.mock.calls[0][1]).toBe(args);
    },
  );
  it.each(["create", "update", "delete"])(
    "does not fall back when %s preparation refuses",
    async (action) => {
      const refusal = { content: [{ type: "text", text: '{"ok":false,"error":"refused"}' }] };
      stage.mockResolvedValue(refusal);
      expect(await buildTools().get(`scopely_${action}_scoping_card`)!.execute("call", {})).toBe(
        refusal,
      );
      expect(stage).toHaveBeenCalledTimes(1);
    },
  );
});
