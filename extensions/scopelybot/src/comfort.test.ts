// Comfort-message tests (comfort.ts — Slice 4 context-aware additions).
// Cover: deterministic domain classification (each vocabulary bucket routes
// to its message; unknown text falls back to the generic pool) and the
// trivial-greeting skip inside sendComfortMessage. Zoom sends are not
// exercised — sendComfortMessage returns before any network call when the
// channel/env guards fail, which is the path these tests pin.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// comfort.ts captures SCOPELYBOT_ZOOM_CHANNEL at module load — hoist the env
// assignment above the import so the channel guard passes in the send tests.
vi.hoisted(() => {
  process.env.SCOPELYBOT_ZOOM_CHANNEL = "chan@conference.xmpp.zoom.us";
});

import { pickComfortText, resolveInboundThreadAnchor, sendComfortMessage } from "./comfort.js";

describe("pickComfortText — deterministic domain classification", () => {
  const cases: Array<[string, string]> = [
    ["reset the password for jrickert", "Checking user records..."],
    ["what does the rate card say for RC?", "Pulling pricing details..."],
    ["update the vendor scoping card for 8x8", "Checking vendor configuration..."],
    ["archive session 713 please", "Looking into the deal pipeline..."],
    ["is the extraction service healthy?", "Checking system health..."],
    ["any open github issues on the repo?", "Checking the repo and deploys..."],
  ];
  for (const [inbound, expected] of cases) {
    it(`"${inbound.slice(0, 40)}" → "${expected}"`, () => {
      expect(pickComfortText(inbound)).toBe(expected);
    });
  }

  it("unrecognized vocabulary falls back to the generic pool", () => {
    const text = pickComfortText("qwertyuiop zxcvbnm");
    expect([
      "On it — pulling up the details now...",
      "Looking into that, one moment...",
      "Checking Scopely VIP, hang tight...",
      "Gathering the info now...",
      "Let me dig into that...",
    ]).toContain(text);
  });
});

describe("sendComfortMessage greeting skip", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.ZOOM_BOT_JID = "bot@xmpp.zoom.us";
    process.env.ZOOM_ACCOUNT_ID = "acct";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    delete process.env.ZOOM_BOT_JID;
    delete process.env.ZOOM_ACCOUNT_ID;
    vi.unstubAllGlobals();
  });

  it("skips trivial greetings and acks entirely (no token fetch, no send)", async () => {
    for (const greeting of ["hi", "Hello!", "thanks", "ok", "Good morning", "gm."]) {
      await sendComfortMessage("chan@conference.xmpp.zoom.us", undefined, greeting);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a greeting with request content still comforts (guard is narrow)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "t", expires_in: 3600 }),
    });
    await sendComfortMessage(
      "chan@conference.xmpp.zoom.us",
      undefined,
      "hi, how many sessions are in progress?",
    );
    expect(fetchMock).toHaveBeenCalled(); // token fetch happened → send path taken
  });
});

describe("resolveInboundThreadAnchor — thread-root anchoring (2026-07-22 incident)", () => {
  // Zoom renders a bot reply inside a thread ONLY when reply_main_message_id is
  // the thread ROOT. For a thread-reply inbound, messageId is the child message;
  // threadId (canonical MessageThreadId from the zoom adapter) is the root.
  it("prefers threadId (root) when the inbound is a thread reply", () => {
    expect(
      resolveInboundThreadAnchor({ messageId: "child-msg-id", threadId: "root-msg-id" }),
    ).toBe("root-msg-id");
  });

  it("falls back to messageId for a top-level inbound (no threadId)", () => {
    expect(resolveInboundThreadAnchor({ messageId: "top-level-id" })).toBe("top-level-id");
  });

  it("returns undefined when neither id is present", () => {
    expect(resolveInboundThreadAnchor({})).toBeUndefined();
  });

  it("ignores non-string / blank values", () => {
    expect(resolveInboundThreadAnchor({ messageId: 42, threadId: "   " })).toBeUndefined();
    expect(resolveInboundThreadAnchor({ messageId: "m-1", threadId: 99 })).toBe("m-1");
  });
});
