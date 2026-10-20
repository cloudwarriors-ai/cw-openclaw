# ScopelyBot backend profile

The profile selects the app origin, credentials and bot write mode. The request guard, confirmation path and capability registry reread it on each request. A missing, invalid or unsafe profile fails closed: no allowed host and no app request.

## Files and authority

The runtime workspace contains `scopelybot-backend.json` and the separately provisioned `scopelybot-ops-token`. The workspace is `OPENCLAW_WORKSPACE`, otherwise the gateway's default workspace. Resolve the actual persistent mount and runtime UID before deployment; do not assume a development UID.

The token file must be a regular runtime-owned0600 file. Never put the token in the profile, examples, logs or prompts. Tailscale supplies private connectivity; native app permissions and the server approver roster remain the authority. The older `scopelybot-approvers.json` file does not establish native write authority.

## Production starts read only

Use the private release owner's reviewed origin and exact allowed host. The following is documentation with placeholders, not an executable production profile:

```json
{
  "profile": "zw2",
  "env": "prod",
  "mode": "read-only",
  "productionCoreWrites": false,
  "authMode": "service-token",
  "baseUrl": "https://<reviewed-private-host>:9443",
  "allowedHosts": ["<reviewed-private-host>:9443"],
  "digestEnabled": false,
  "maxRequestsPerMinute": 20
}
```

Only origins accepted by `ops-write-policy.ts` and `backend-profile.ts` are valid; an operator cannot add an arbitrary host through JSON. The former public API profile and the old dev IP are legacy fixtures, not the native operator deployment recipe. The checked-in production readonly example now uses the already reviewed private origin and explicitly disables `productionCoreWrites`; offline preflight rejects the old public origin or a true write flag. It cannot certify a live deployment. Keep `digestEnabled` false: the legacy digest uses admin paths outside this release's operator surface.

Read-only mode denies business writes and confirmation execution. Native REST/MCP read capabilities may use POST transport; read-only does not mean every HTTP POST is a mutation.

## Explicit write activation

Production native writes are implemented but default off. Enabling them requires all of the following:

- A matched, reviewed backend and gateway build, approved production vendor/channel/principal scope, verified native identity links and current server roster.
- Backend production admission and the selected business-family switches enabled through the release procedure, with local-write flags off.
- The reviewed private production origin, service-token auth, `mode: "read-write"` and `productionCoreWrites: true` in the effective bot profile.
- The bot agent's reviewed tool allowlist and its exact original channel binding. An agent/session prefix never substitutes for a channel match; confirmation matches the actual dispatch conversation, including threaded replies.
- Persistent audit storage and `SCOPELYBOT_CONFIRM_CODE_DIR` pointing inside the persistent mount. The code directory is runtime-owned0700; reservations are0600 and retained across restart and rollback. Never empty or restore older code history.
- A chosen safe acceptance vendor and quote, human confirmation, readback and separate operator go/no-go. No target means read-only acceptance only.

Only the seven reviewed native pricing/catalog operations and supporting controls are eligible. Legacy raw writes, account/lifecycle/delivery actions and unrelated tools do not become production-enabled through this profile.

## Private Noob development bot

The lasting development bot uses its own native service principal, token and
server roster against the migrated development database. It does not borrow a
Claude connector credential. Its reviewed private Docker profile is:

```json
{
  "profile": "zw2",
  "env": "dev",
  "mode": "read-write",
  "authMode": "service-token",
  "baseUrl": "http://vip-noob-bot-native:8000",
  "allowedHosts": ["vip-noob-bot-native:8000"],
  "developmentCoreWrites": true,
  "digestEnabled": false,
  "maxRequestsPerMinute": 20
}
```

Only that exact origin, one allowed host, no Host override and service-token
authentication admit development Core7 writes. Public development URLs and the
old sprint IP do not. The native backend must independently enable `noob_bot`,
pin its database/principal/channel/vendor and exact real Zoom identity mappings,
and recheck the human's current native permissions and roster. Every mutation
still needs the human confirmation code; raw legacy mutations are refused.
The trusted gateway constructs sender/channel headers from verified inbound
context. A compromised principal credential holder is inside that trust
boundary; the header alone is not independent proof of human presence.
The request guard emits the fixed bare internal hostname for native ingress's
exact Host fence; operators and tool arguments cannot choose that header.

Deploy the matched gateway/plugin build on private ingress with persistent
token, audit and code-reservation custody. Retain reservations through rollback.
An offline test or this profile file does not prove a lasting bot was deployed:
acceptance must identify its loaded image/plugin hashes and actual request
destination, then verify a human-confirmed action against the live native DB.

## Local synthetic profile

Local native testing uses `env: "local"` and the code-reviewed loopback origin. Development host/header overrides are separately constrained in `backend-profile.ts`; do not copy a synthetic principal, user, vendor or channel into production. A profile's environment is operator-supplied and must be checked against the actual stack.

## Changes and rollback

Replace the profile atomically using a temporary file in the same directory. A profile change applies on the next request, but shared gateway environment, tool allowlist or binding changes need the reviewed host reload/restart procedure. Preserve other bots and the live shared configuration.

`mode: "off"` prevents app requests and confirmations; `read-only` prevents business writes. Freeze first on uncertain outcomes, retain audit/pending/code history and reconcile before any new preview. Do not retry an uncertain mutation or roll back to older reservations. Profile changes are recorded in the bot audit chain; backend identity and business audit records provide the native action attribution.

Production Core7 staging and confirmation are gateway-principal-only. A personal
operator credential can read within its native permissions, but cannot bypass
Zoom confirmation or the roster to write in production. The effective profile
is read per request: editing it can enable only the bot-side admission. Backend
write flags, exact principal/channel/vendor scope, native identity and roster
must independently admit the operation. Treat profile changes as controlled
configuration changes with recorded owner approval. No restart-only claim is made.
