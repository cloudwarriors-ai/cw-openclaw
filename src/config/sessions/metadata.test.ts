import { describe, expect, it } from "vitest";
import { deriveSessionMetaPatch } from "./metadata.js";

describe("deriveSessionMetaPatch", () => {
  it("captures origin + group metadata", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(patch?.origin?.label).toBe("Family id:123@g.us");
    expect(patch?.origin?.provider).toBe("whatsapp");
    expect(patch?.subject).toBe("Family");
    expect(patch?.channel).toBe("whatsapp");
    expect(patch?.groupId).toBe("123@g.us");
  });

  it("preserves GroupSubject when GroupChannel is an opaque provider id", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "zoom",
        Surface: "zoom",
        ChatType: "channel",
        GroupSubject: "test-customer",
        GroupChannel: "a04c5d88d32d4ba3a3949fd6e5929d5b@conference.xmpp.zoom.us",
        From: "zoom:channel:a04c5d88d32d4ba3a3949fd6e5929d5b@conference.xmpp.zoom.us",
      },
      sessionKey: "agent:presales:zoom:channel:a04c5d88d32d4ba3a3949fd6e5929d5b@conference.xmpp.zoom.us",
    });

    expect(patch?.groupChannel).toBe("a04c5d88d32d4ba3a3949fd6e5929d5b@conference.xmpp.zoom.us");
    expect(patch?.subject).toBe("test-customer");
  });
});
