// Agent profiles for the test-capture harness. One entry per Zoom-bound agent.
// The harness is agent-agnostic — adding a bot is just another entry here, no code.
//
//   channelIdRaw : the raw hex channel id used in the inbound webhook payload
//   channelJid   : the full XMPP JID the bot sends outbound to (the egress capture key)
//   sessionKey   : the coordinator's channel session key (for /reset isolation)
//   operator     : the email stamped as the message sender in the synthetic webhook

export const PROFILES = {
  scopelybot: {
    agentId: "scopelybot",
    channelIdRaw: "575b23671d6b4b7f8c22b1924b6177fa",
    channelJid: "575b23671d6b4b7f8c22b1924b6177fa@conference.xmpp.zoom.us",
    sessionKey:
      "agent:scopelybot:zoom:channel:575b23671d6b4b7f8c22b1924b6177fa@conference.xmpp.zoom.us",
    operator: "matt.keuning@cloudwarriors.ai",
    // Coordinator's allowlisted non-domain tools — used to assert "router-only".
    routerTools: ["sessions_spawn", "subagents", "scopely_health_check", "scopely_auth_status"],
  },
};

export function getProfile(name) {
  const p = PROFILES[name];
  if (!p) {
    throw new Error(`unknown profile "${name}" — known: ${Object.keys(PROFILES).join(", ")}`);
  }
  return p;
}
