// Verifies Scopely-only, loss-aware plain-text formatting for Zoom delivery.
import { describe, expect, it } from "vitest";
import {
  formatScopelyZoomText,
  isScopelyBotZoomMessage,
  rewriteScopelyBotZoomMessage,
} from "./zoom-format.js";

describe("formatScopelyZoomText", () => {
  it("cleans the screenshot-shaped support response", () => {
    const content = `- **Operational active vendors:** **20** (23 active records total; 3 are non-operational).
*Source: current vendor catalog.*

- **Open customer-facing access issue:** **Yes — 1 issue.**
**#1108:** External customers see “Application not found” after Zoom sign-in because the Marketplace app is unpublished. Internal users are unaffected.
*Source: GitHub issue \`cloudwarriors-ai/scopely#1108\`, updated 2026-07-18 14:30 UTC.*

**What to do:** Route affected external customers through the manual **capture** path instead of **Connect Zoom**, and track the fix through issue #1108.`;

    expect(formatScopelyZoomText(content)).toBe(
      `• Operational active vendors: 20 (23 active records total; 3 are non-operational).
Source: current vendor catalog.

• Open customer-facing access issue: Yes — 1 issue.
#1108: External customers see “Application not found” after Zoom sign-in because the Marketplace app is unpublished. Internal users are unaffected.
Source: GitHub issue cloudwarriors-ai/scopely#1108, updated 2026-07-18 14:30 UTC.

What to do: Route affected external customers through the manual capture path instead of Connect Zoom, and track the fix through issue #1108.`,
    );
  });

  it("preserves readable plain text exactly", () => {
    const content = "There are 20 operational vendors.\n\nIssue #1108 is the one to watch.";
    expect(formatScopelyZoomText(content)).toBe(content);
  });

  it("keeps links and technical identifiers useful", () => {
    const content =
      "See [issue 1108](https://github.com/cloudwarriors-ai/scopely/issues/1108) for `vendor_id`. Call `__init__` next; the `_id_` field is required. Source: GitHub issue #1108. 2 * 3 * 4 is still 24.";
    expect(formatScopelyZoomText(content)).toBe(
      "See issue 1108 (https://github.com/cloudwarriors-ai/scopely/issues/1108) for vendor_id. Call __init__ next; the _id_ field is required. Source: GitHub issue #1108. 2 * 3 * 4 is still 24.",
    );
  });

  it("removes headings, quote markers, fences, and excessive blank lines", () => {
    const content = "## Result\n\n> Clear answer\n\n\n```text\nstatus=healthy\n```";
    expect(formatScopelyZoomText(content)).toBe("Result\n\nClear answer\n\nstatus=healthy");
  });
});

describe("ScopelyBot Zoom formatting scope", () => {
  it("matches only canonical ScopelyBot Zoom sessions", () => {
    expect(
      isScopelyBotZoomMessage({ channelId: "zoom", sessionKey: "agent:scopelybot:zoom:vip" }),
    ).toBe(true);
    expect(isScopelyBotZoomMessage({ channelId: "zoom", sessionKey: "agent:other:zoom:vip" })).toBe(
      false,
    );
    expect(
      isScopelyBotZoomMessage({ channelId: "slack", sessionKey: "agent:scopelybot:slack:vip" }),
    ).toBe(false);
    expect(isScopelyBotZoomMessage({ channelId: "zoom" })).toBe(false);
  });

  it("returns no rewrite for already-readable or out-of-scope messages", () => {
    expect(
      rewriteScopelyBotZoomMessage("Already readable.", {
        channelId: "zoom",
        sessionKey: "agent:scopelybot:zoom:vip",
      }),
    ).toBeUndefined();
    expect(
      rewriteScopelyBotZoomMessage("**Do not change**", {
        channelId: "zoom",
        sessionKey: "agent:other:zoom:vip",
      }),
    ).toBeUndefined();
  });
});
