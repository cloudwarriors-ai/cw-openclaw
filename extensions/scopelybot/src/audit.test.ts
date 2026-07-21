import { describe, expect, it, vi } from "vitest";
import { wrapToolWithAudit } from "./audit.js";

describe("write audit summaries", () => {
  it("does not describe a staged write as executed", async () => {
    const logger = vi.fn();
    const tool = wrapToolWithAudit(
      {
        name: "scopely_test_write",
        description: "test",
        parameters: {},
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ staged: true, awaiting_confirmation: true }),
              },
            ],
          };
        },
      },
      logger,
    );

    await tool.execute("call", {});

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ resultSummary: "staged: awaiting confirmation" }),
    );
  });
});
