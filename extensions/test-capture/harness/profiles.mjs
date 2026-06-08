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
  bigheadbot: {
    agentId: "bigheadbot",
    channelIdRaw: "567a6810959543b5b7c1cacf6af7c013",
    channelJid: "567a6810959543b5b7c1cacf6af7c013@conference.xmpp.zoom.us",
    sessionKey:
      "agent:bigheadbot:zoom:channel:567a6810959543b5b7c1cacf6af7c013@conference.xmpp.zoom.us",
    operator: "matt.keuning@cloudwarriors.ai",
    // bigheadbot is currently a SINGLE agent (confirm-gate hardened, not yet hub-split).
    // The router-only assertion is N/A until the optional measure-gated coordinator/spoke
    // split lands; this lists the planned coordinator liveness set for that future state.
    routerTools: ["sessions_spawn", "subagents", "bh_auth_status"],
    split: false,
  },
  zoomwarriorssupportbot: {
    agentId: "zoomwarriorssupportbot",
    channelIdRaw: "f1f7b4c3e9b54e8cbc205b007c5fd6e5",
    channelJid: "f1f7b4c3e9b54e8cbc205b007c5fd6e5@conference.xmpp.zoom.us",
    sessionKey:
      "agent:zoomwarriorssupportbot:zoom:channel:f1f7b4c3e9b54e8cbc205b007c5fd6e5@conference.xmpp.zoom.us",
    operator: "matt.keuning@cloudwarriors.ai",
    // Confirm-gate hardened, not yet hub-split (measure-gated). Planned coordinator
    // liveness set for the future split state.
    routerTools: ["sessions_spawn", "subagents", "zws_auth_status"],
    split: false,
  },
  pulsebot: {
    agentId: "pulsebot",
    channelIdRaw: "b6a0428ca4364fd9873fe6a2ea1376fd",
    channelJid: "b6a0428ca4364fd9873fe6a2ea1376fd@conference.xmpp.zoom.us",
    sessionKey:
      "agent:pulsebot:zoom:channel:b6a0428ca4364fd9873fe6a2ea1376fd@conference.xmpp.zoom.us",
    operator: "matt.keuning@cloudwarriors.ai",
    // Confirm-gate hardened, not yet hub-split (measure-gated). Planned coordinator
    // liveness set for the future split state.
    routerTools: ["sessions_spawn", "subagents", "pp_auth_status"],
    split: false,
  },
  "cloudflow-support": {
    agentId: "cloudflow-support",
    channelIdRaw: "82a0a9b6ca134457b58151734ee5643b",
    channelJid: "82a0a9b6ca134457b58151734ee5643b@conference.xmpp.zoom.us",
    sessionKey:
      "agent:cloudflow-support:zoom:channel:82a0a9b6ca134457b58151734ee5643b@conference.xmpp.zoom.us",
    operator: "matt.keuning@cloudwarriors.ai",
    // Confirm-gate hardened, not yet hub-split (measure-gated). Planned coordinator
    // liveness set for the future split state.
    routerTools: ["sessions_spawn", "subagents", "cf_discover_ops"],
    split: false,
  },
};

export function getProfile(name) {
  const p = PROFILES[name];
  if (!p) {
    throw new Error(`unknown profile "${name}" — known: ${Object.keys(PROFILES).join(", ")}`);
  }
  return p;
}
