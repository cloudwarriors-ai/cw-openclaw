# ScopelyBot operator-layer client (M13 slice 1)

The bot's slice-1 reads go to the ZW app's operator layer: one generic invoke edge, `POST /api/spine/v1/ops/invoke/`, where every call is authorized for the acting human and audited by the app. The bot authenticates with its service token and names the human who asked by their Zoom user id (`IDENTITY-B-CONTRACT.md`, owner decision 2026-10-13: the only identifier Zoom itself asserts on every inbound path).

Code: `src/ops-client.ts` (tool entry and answers), `src/scopely-api.ts` (`scopelyOpsInvoke`, the guard branch), `src/backend-profile.ts` (`authMode`, `readOpsToken`), `src/capability-registry.ts` (`OPS_READS`, tool to capability). Kernel side: zoomwarriors_2 `apps/opsplane` at commit `87b8b516` (`identity.py`, `edge_rest.py`, `kernel.py`, `capabilities_system.py`, `capabilities.snapshot.json`).

## Flow

1. The model calls a slice-1 tool. The registry wrapper runs it inside the call context (tool name, requester from the trusted tool-factory context).
2. The tool's execute is `opsRead`. It refuses unless it runs inside that context and the tool has a binding in `OPS_READS`. The binding fixes the capability and which tool params become `args`. Native account discovery and `scopely_list_pricing_items` validate raw declared fields before host coercion and preserve unknown fields for strict backend validation; other bindings retain their existing allowlist/default behavior.
3. `invoke` resolves the requester's canonical Zoom id (rule below) and calls `scopelyOpsInvoke` once.
4. The guard validates, applies the kill switch and the rate cap, reads the token file, writes the `http_intent` row, then sends exactly one request. It never follows a redirect and never retries.
5. The app answers (shapes below). The guard writes the terminal row, and `invoke` turns the answer into the tool result.

| Tool                                          | Capability                      | Args                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scopely_health_check`                        | `system.health`                 | none                                                                                                                                                                                       |
| `scopely_auth_status`                         | `system.whoami`                 | none                                                                                                                                                                                       |
| `scopely_list_vendors`                        | `catalog.vendors.list`          | none                                                                                                                                                                                       |
| `scopely_get_vendor`, `scopely_vendor_config` | `catalog.vendors.get`           | `vendor_key`                                                                                                                                                                               |
| `scopely_list_project_types`                  | `catalog.project_types.list`    | `vendor_key`                                                                                                                                                                               |
| `scopely_list_deployment_types`               | `catalog.deployment_types.list` | `vendor_key`, `project_type`                                                                                                                                                               |
| `scopely_list_scoping_cards`                  | `catalog.scoping_cards.list`    | `vendor_key`, `project_type`                                                                                                                                                               |
| `scopely_get_scoping_card`                    | `catalog.scoping_cards.get`     | `vendor_key`, `project_type`, `card_key`                                                                                                                                                   |
| `scopely_list_pricing_defaults`               | `pricing.defaults.list`         | `vendor_key` (required), `scope_category`, `limit` (at most 20; the bot sends 20 when none is given), `offset`                                                                             |
| `scopely_list_sessions`                       | `sessions.list`                 | `status` (list of order statuses), `search` (company name, order number or organization name), `organization_id`, `page`, `page_size` (default 25; the bot allows at most 30, the app 100) |
| `scopely_get_session`                         | `sessions.get`                  | exactly one of `session_id` (integer) or `order_number` (`PS-<digits>`)                                                                                                                    |

Every other tool stays refused by the registry, as before. Old parameters with no equivalent in the new app were dropped: `scopely_list_sessions` lost `vendor`, `created_by`, `date_from` and `date_to`, `limit` became `page_size`, its status values are the new order statuses, and `search` no longer matches contact fields (they are excluded as PII); `scopely_get_session` took a string `id` and now takes `session_id` or `order_number`. The kernel's optional filters the old tools never had (`catalog.vendors.list` `search`/`is_source`/`is_destination`, `catalog.project_types.list` `enabled_only`, `pricing.defaults.list` `category`/`is_active`) are not exposed yet.

The kernel's snapshot is the authority on names and schemas. `src/fixtures/ops-capabilities.snapshot.json` is a byte copy of it at `87b8b516` (sha256 `a38f89c3...0d5c`, (retrieved 2026-10-13; its sha256 is pinned in `src/ops-client.test.ts`). The registry tests fail when a binding names a capability the snapshot lacks, when a tool's parameters differ from its binding's args (names, types, required keys, enums), or when the args a tool sends do not validate against the capability's input schema. Refresh: copy the committed snapshot again and update the pin.

## The request

The guard builds all of it. A caller supplies only the capability, the args and the requester.

- `POST <baseUrl>/api/spine/v1/ops/invoke/?bot_audit_id=<audit_id>`
- body `{"capability": ..., "args": {...}, "correlation_id": "<audit_id>"}`
- headers: `content-type: application/json`, `authorization: Bearer <token>`, `x-ops-bot-audit-id: <audit_id>`, `x-correlation-id: <audit_id>`, `x-vipbot-client`, `x-ops-requester-zoom-id: <canonical Zoom id>` (only when the rule below yields one; the old `x-ops-requester` email header is never sent), and the dev `host` override when the profile has one.

The kernel accepts only `Authorization: Bearer zwops_<12 hex>_<32-64 of A-Za-z0-9_->` (`identity.py`). It takes the correlation id from the body (else `X-Correlation-Id`) and, for service tokens, stores `X-Ops-Bot-Audit-Id` as `bot_audit_id`; both must match `[A-Za-z0-9._:-]{1,128}` (`edge_rest.py`). The audit id is a ULID, which always matches; the guard still checks it and refuses before any I/O if it does not (`header_blocked`). The same audit id is in the query parameter, both headers and the body, so the bot's chain and the app's `OpsAuditEvent` rows join on it.

## How the guard admits it, and what did not widen

`scopelyFetch` stays as it was: GET and HEAD only (outside a dev read-write profile), caller headers limited to `accept` and `content-type`, no body on a GET. The invoke is a separate entry, `scopelyOpsInvoke`, that shares the same single request function and the same checks, plus:

- the method is always POST and the path is always exactly `/api/spine/v1/ops/invoke/`. A `scopelyFetch` caller sending POST, PUT, PATCH or DELETE to that path, or to any other path, is still refused (`write_blocked_read_only`);
- the capability must be in `OPS_READ_CAPABILITIES`, the eleven slice-1 reads. Any other name is refused before any I/O (`write_blocked_read_only`), so the bot stays read-only even if the kernel registers a write. Adding one is a reviewed code change;
- args must be a JSON object of at most 4 KB (`body_blocked`); the requester id must already be canonical, `^[a-z0-9_-]{6,64}$` (`header_blocked`, before any I/O);
- the caller header allow-list is NOT widened: the guard adds `authorization`, `x-ops-requester-zoom-id` and `x-ops-bot-audit-id` itself, and only to the invoke. A caller sending any of them, `x-ops-requester`, `x-service-token`, `x-on-behalf-of` or `x-correlation-id` is refused (`header_blocked`). A GET under `authMode: "service-token"` carries none of them;
- the read-only rule and the dev write latch do not apply to the invoke (it is a read); the kill switch (`mode: "off"`) and the per-minute cap do, and the kill switch is checked before the token file.

## The token file

`<workspace>/scopelybot-ops-token`, next to `scopelybot-backend.json`, read on every invoke (no cache, no env, no restart needed after a rotation). It must hold a SERVICE token minted by the app's `manage.py ops_mint_token --principal <org-slug>/<principal name>`: the shape cannot tell a person token (`--user`) apart, and a person token acts as its owner whenever no requester header is sent, so every unmapped asker would become that person. The guard refuses the invoke, writes an `auth_unavailable` row with only the problem code, and sends nothing when:

| Code               | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `missing`          | no file                                                                               |
| `not_regular_file` | a directory, FIFO or symlink (opened with `O_NOFOLLOW`)                               |
| `not_owner`        | not owned by the gateway's own user (root in production)                              |
| `permissions`      | any group or other permission bit (expected `0600`)                                   |
| `empty`            | only whitespace                                                                       |
| `malformed`        | not exactly one kernel-shaped token `zwops_<12 lowercase hex>_<32-64 of A-Za-z0-9_->` |
| `too_large`        | over 4 KB                                                                             |
| `unreadable`       | any other open or read error                                                          |

Surrounding whitespace (a trailing newline) is ignored. The token never appears in a message, an audit row, a log line, tool params or a tool result. A well-shaped token the app does not know, has revoked or let expire (30 days by default, 90 at most) is answered 401 by the app (below). Rotation: mint a new token, write it to a temporary file in the same directory with mode 0600, `mv` it over the old one, then revoke the old token in the app.

## Requester rule

`x-ops-requester-zoom-id` carries the asker's canonical Zoom user id only when both hold:

1. the call's requester is resolved from the trusted tool-factory context, which means a human-triggered run of the coordinator itself (`docs/audit-v2.md`, requester attribution); and
2. the sender sequence captured by the run’s tools is still current, and the trusted host’s process-local monotonic run start is strictly newer than that sequence’s start. Missing, invalid, equal, or older start metadata refuses identity. Lazy factory rebuilding cannot bind an old run to a newer sequence. The `message_received` hook records a canonical sender and an opaque epoch per session (`noteInboundSender`, at most 1,000 sessions). Another sender, an unknown sender, reset, or eviction invalidates the old run permanently, even if the original person posts again. Repeated messages from the same canonical sender preserve the epoch. An invalidated run makes no requester claim; only a fresh host run after a human message can establish a new claim. This protects against the host’s `steer` mode injecting another person’s instructions into an existing run.

Canonical form (`canonicalZoomId`, the same rule as the kernel's `normalize_zoom_user_id`, pinned by the 56 shared vectors in `src/fixtures/zoom_id_vectors.json`, a copy of the backend's `apps/opsplane/tests/zoom_id_vectors.json`; a second, independent implementation in the mock kernel passes the same table): trim ASCII whitespace only (a NO-BREAK SPACE or BOM is not trimmed); drop one trailing `@xmpp.zoom.us`, ASCII case ignored; the rest must be ASCII `[A-Za-z0-9_-]{6,64}` (checked before lower-casing, so a KELVIN SIGN cannot become `k`), then lower-cased; anything else has no canonical form, so no header. Team chat carries the case-preserved operator id, the chatbot path a lowercase JID; both give the same canonical id.

Otherwise no header is sent: spokes, the coordinator's own subagents, announce runs, runs another person has posted into, and sender ids that are not Zoom ids, including a value with a comma (which the kernel would call ambiguous: the bot never sends one) and a canonical id the kernel would call secret-shaped (containing `zwops_`, or 32+ characters mixing letters and digits; real Zoom ids are 22 characters). The kernel maps the id through `ZoomIdentityLink.zoom_user_id` and `bot_actor_for` (the linked user must be active and a member of the service principal's organization, so the principal must live in its users' organization: the platform org for staff reads). No header is `missing`; an unknown, inactive or cross-org id is `unmapped`. For either, the kernel allows `system.whoami` only and refuses everything else with 403 `requester_unresolved`. The requester never comes from tool params, model text or the approver ledger (`scopelybot-approvers.json` stays only for the approver-grant feature).

## Answers

The app answers in three shapes:

- success (`kernel.py`): `{ok: true, request_id, correlation_id, capability, untrusted_output, data}`; list capabilities return `data = {items: [...], total, truncated, ...}`;
- kernel refusal (`kernel.py` `_error`): `{ok: false, request_id, correlation_id, capability, error: {detail, code, request_id}}`;
- edge refusal (`spine_api/views/base.py` `_envelope`, before the kernel runs): `{detail, code, request_id}`, for a 401 token failure, the emergency 503 `ops_disabled` and a 400 on a malformed correlation or bot audit id.

| Answer                                                                                                                | Tool result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| success                                                                                                               | `{ok: true, capability, request_id, untrusted, data}` (plus `summary` for whoami and health, and `caveat` for pricing defaults); data over 16,000 characters is cut: an `items` list keeps its leading items and the result says `output_cut: true`, `items_shown` and a `note` (showing N of M; ask for a smaller page_size or a narrower filter); anything else becomes a cut string with `output_cut` and a note. `output_cut` is the bot's flag; paged `data.next_offset` and `data.truncated` describe the rows actually shown                                                                                                                                                                                                                                                                      |
| kernel or edge refusal                                                                                                | `{ok: false, capability, request_id, status, refusal: <code>, error}`; the error is the plugin's own sentence for the code, never the app's detail, which is operator wording ("Invalid token.", header names) and goes only to the outcome row (`result.kernel.detail`, redacted, at most 200 characters). `invalid_args` alone adds the app's detail (redacted, at most 300 characters), because it names the model's own failing argument. `requester_unresolved` says either "Your Zoom id X is not linked to a ZW user the bot may act for, so only whoami is available. Ask an admin to link Zoom id X to your ZW user." (an id was sent) or that the bot named nobody (no id sent). An unknown code answers with the code only; the code is cut at 64 characters and looked up as an own key only |
| a body over the invoke's read cap (264 KB: the kernel's 256 KB result bound plus envelope; other requests keep 64 KB) | `{ok: false, status, error}`: the answer was too large and nothing is shown; ask for fewer items. The outcome row says `result.status: "truncated"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| not an envelope (a proxy page)                                                                                        | `{ok: false, status, error, untrusted, body}` with at most about 1 KB of the body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| guard refusal, network error, 429                                                                                     | the error text (redacted, tokens included), `ok: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

| Code (status)                                                                                          | Where  | Meaning                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication_failed` (401)                                                                          | edge   | token missing, wrong, revoked, expired, owner inactive                                                                                                                     |
| `ops_disabled` (503)                                                                                   | edge   | emergency kill switch (`OPS_KILL_ALL` or the kill file)                                                                                                                    |
| `validation_error` (400)                                                                               | edge   | malformed body, correlation or bot audit id                                                                                                                                |
| `parse_error` (400), `payload_too_large` (413), `unsupported_media_type` (415), `not_acceptable` (406) | edge   | not JSON or nested too deep, body over 64 KB, not a JSON body, an Accept that admits no JSON (none of them sent by the guard)                                              |
| `unknown_capability` (404)                                                                             | kernel | no such capability                                                                                                                                                         |
| `requester_unresolved` (403)                                                                           | kernel | no acting user; only whoami                                                                                                                                                |
| `capability_disabled` (503)                                                                            | kernel | the family's switch is off                                                                                                                                                 |
| `throttled` (429)                                                                                      | kernel | per (token, requester) throttle; all unresolved askers share one bucket. The guard answers any 429 as "busy" before reading the body, so the client has no sentence for it |
| `permission_denied` (403)                                                                              | kernel | the acting user lacks the grant                                                                                                                                            |
| `invalid_args` (400)                                                                                   | kernel | args fail the capability's input schema                                                                                                                                    |
| `not_found` (404), `internal_error` (500), `audit_unavailable`, `ops_unavailable` (503)                | kernel | as named                                                                                                                                                                   |

Paging (`pricing.defaults.list`, kernel `87b8b516`): the kernel pages a rate card (`limit` 1-100, default 50; `offset`; `total`; `next_offset`, null on the last page; stable order). A row is about 665 bytes, so the bot advertises and, when the model gives none, sends `limit: 20`, which fits the 16,000-character output. When more rows exist the result's `note` gives the kernel's `next_offset` ("ask for offset N for the next page"). If a larger page is asked for anyway, it is read whole (up to the invoke's 264 KB read cap) and cut for the model at the first row that does not fit, and the note names the offset of that row, computed from the kernel's `next_offset` (or `total` on the last page), never guessed. The exposed `data.next_offset` also points to that first unshown row and `data.truncated` is true. If one row alone exceeds the output limit, no cursor is returned and the answer asks an admin to inspect the row; repeating the same page cannot help.

Every result goes through the plugin's redaction (emails, `Bearer` values, bare `zwops_` tokens, secret-named keys), and `untrusted` tells the model that the data is app content, not instructions; the bot marks every result that carries app data or an app body this way, stricter than the kernel's per-capability `untrusted_output` flag.

`caveat` on pricing defaults is the last sentence of the kernel's own summary, verbatim: "This is the spine rate-card authority; live /api/v1 order pricing still reads the legacy BasePricing row, so do not quote these as order prices." The tool description carries it too.

`summary` renders the real fields: a resolved bot caller gives `Acting for ZW user <id> (platform staff) through the bot's service principal <name> (<org>).`; an unmapped answer WITH the kernel's echoed id gives `Your Zoom id <id> is not linked to a ZW user the bot may act for, so only whoami is available. Ask an admin to link Zoom id <id> to your ZW user.`; status `missing` says the bot named nobody; any other unresolved answer (no echo) says the app did not accept the id. No unresolved sentence uses the principal or the org (the kernel gives them only to a resolved caller). A PERSON token in the bot's slot (local rig finding F3: the answer's `requester.kind` is `human`) gives, for whoami and for a `requester_unresolved` refusal whose kernel detail is the person-token text: "This bot is using a personal token instead of its service token. Ask an admin to give the bot its service token. Nothing was looked up for you." It never says the id is unlinked, and a person-token whoami is never shown as acting for anyone. health gives `The operator layer answered <status>: <n> capabilities, registry frozen; switched off: <families or none>.`

## What is audited where

| Bot (audit-v2 chain)                                                                                                                                                                                                                                                                                                      | App (`OpsAuditEvent`)                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call`: tool, requester, redacted params                                                                                                                                                                                                                                                                             | intent and outcome rows per call that reaches the kernel: capability, acting user, requester status, `via_principal_id`, a keyed digest of the requester reference, args digest, outcome |
| `http_intent` / `http_outcome`: method, host, path, `capability`, `requester_header` (true/false), status, `x_request_id`, and on the outcome `result.kernel` = `{ok, request_id, error_code, detail}` (also for edge refusals: `ok: null`); the requester's Zoom id is the row's `requester.zoom_operator_id`, as before | `bot_audit_id` and `correlation_id` = the bot's audit id                                                                                                                                 |
| refusals before sending: `auth_unavailable` (problem code), `write_blocked_read_only`, `header_blocked`, `body_blocked`, `backend_off`, `rate_limited`                                                                                                                                                                    | nothing (no request)                                                                                                                                                                     |

`bot_principal.auth_mode` on every row is the profile's `authMode`. The join: bot `http_intent.audit_id` = app `bot_audit_id`; app `request_id` (also the `x-request-id` response header) = bot `http_outcome.result.kernel.request_id` and `http.x_request_id`. Edge refusals (401, emergency 503) write no app audit row.

## Failure modes

| Failure                       | Result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| profile `mode: "off"`         | `backend_off`, nothing sent, the token file not read                |
| `authMode: "anonymous"`       | `auth_unavailable` (`reason: anonymous`), nothing sent              |
| token file problem            | `auth_unavailable` with the code, nothing sent                      |
| audit append fails            | `audit_unavailable`, nothing sent                                   |
| app emergency kill switch     | `refusal: ops_disabled`, one request                                |
| app family switch off         | `refusal: capability_disabled`, one request                         |
| token rejected by the app     | `refusal: authentication_failed`, one request                       |
| unmapped or missing requester | `refusal: requester_unresolved` (whoami still works)                |
| timeout, reset                | one request, error result, outcome row `indeterminate`; not retried |
| HTTP 429                      | busy answer, one request                                            |

## Verification and rollout limits

Local rehearsals C1–C3 exercised real synthetic tokens, the plugin against the running Django kernel, joined bot/kernel audit records, identity failures, throttling and kill switches. C3 used backend `2aef3e0f` and plugin `5055e5c199`: 48 plugin cases passed; 315 of 319 kernel cases passed, with four HTTP whitespace-normalization expectations subsequently corrected. These are local proofs, not production approval.

This round mirrors committed backend `87b8b516`, including paged pricing (limit 1–100), the 264 KB invoke read cap, blank Accept handling and unresolved identity redaction. The snapshot and 56 Zoom-id vectors are byte copies of that backend. This final combination requires its own local delta rehearsal.

Deployment gates remain: trusted real Zoom event payloads, proxy header forwarding, reply-audience policy, concurrent-sender behavior on the production image, service-principal setup, and finalized threat-model review. The bot guard now refuses every non-whoami capability before I/O when the current sender is absent or has drifted, including with a personal token in the service slot. A header-less whoami can still diagnose the credential; service-token kind enforcement at the backend remains a separate trust-boundary consideration. No business write capability is enabled. Production VIP/ZW remains read-only.

Build and deploy the host runtime and ScopelyBot extension from the same reviewed revision. This version requires the host's `requesterRunStartedAt` propagation through the selected harness. Copying only the extension onto an older host will refuse requester-dependent reads and write previews; health/whoami alone cannot validate compatibility. Use a real human-triggered authorized read in the selected harness as the compatibility check. Roll back the complete matched runtime/extension image if it fails; do not synthesize timestamps or bypass the requester guard.

## Slice2 local confirmation canaries

Two migrated writes are available only with a validated local profile: `scopely_update_project_type` and `scopely_update_deployment_type`. Use env `local`, baseUrl `http://127.0.0.1:8100`, allowedHosts `["127.0.0.1:8100"]`, authMode `service-token`, mode `read-write`. Production profiles remain capped at read-only. This is synthetic local testing, not a live-channel rollout.

The current coordinator sender and the epoch captured at tool construction must both still match the inbound session; the host run start must also be newer than the epoch start. The guard prepares an application pending action, then posts the exact preview with `LOCAL SYNTHETIC DATA` and the existing CONFIRM code. Codes and pending IDs never return to the model. Local prompts do not bundle or truncate; rejected/ambiguous delivery invalidates the local code and reports failure without retry. A backend pending action may remain until expiry, with no effect applied.

The human CONFIRM gate keeps its channel and approver checks, then sends the trusted confirming Zoom ID to `ops.confirm`. The backend independently rechecks current authority. Only state `succeeded` yields Done; failed/claimed states do not, even under HTTP200. A claimed outcome requires reconciliation, never an automatic repeat. The audit policy records env `local` explicitly.

Project fields: label/enabled/sort_order/product_info_url. Deployment fields: label/description/long_description/icon/sort_order. Other legacy fields refuse. The other16 used writes remain unported. Claude uses the same backend through native MCP prepare/confirm/cancel/pending, with approval inside its client; actual human-client and live Zoom UAT are still required. No separate approval page.

### Local scoping-card writes

The existing create/update/delete scoping-card tool names now stage the native
`catalog.scoping_cards.*` capabilities, with no legacy write fallback. Select a
project by ID or its stable key, and a card by ID or its stable key; use exactly
one selector at each level. Fields are a complete replacement when supplied.
The backend rejects unsupported field metadata and oversized exact previews;
normal offered-field reads are not complete replacement exports. Confirmation
rechecks the full catalog version and uses the existing Zoom CONFIRM flow.
These tools are partial local parity only: synthetic guards remain in force,
real channel delivery and human Claude approval are untested, and VIP/ZW
production remains read only.

Read arguments remain capped at 4 KiB. Guarded local-write arguments may use up
to 16 KiB; the backend still enforces its combined 16 KiB pending envelope and
2,000-character exact preview. Oversized requests refuse before any effect.

### Native shared pricing writes

Local `scopely_create_pricing_item` and `scopely_update_pricing_item` use
`pricing.items.create/update` through the confirmed ops adapter. Select by
`vendor_key` + `pricing_key`; do not pass old project/entry IDs. Every supplied
argument reaches strict backend validation. No legacy HTTP fallback is attempted.

CONFIRM displays the exact shared vendor change and source card version. A success
creates a successor rate card, preserving history and organization overrides.
Deployment maps follow existing engine rules, not a promise of uniform effects.
Unsupported retirement, tier money edits, obsolete fields and oversized previews
refuse. Production stays read-only; local HTTP
with mocked Zoom delivery is not connected channel or human Claude UAT.

### Confirmation replay protection

ScopelyBot now posts a fresh 128-bit hexadecimal token for each preview. Copy the
complete `CONFIRM <token>` line from that preview. The same authorized human
confirmation flow applies; four-digit codes no longer execute actions. Missing,
short, or suffixed tokens receive a deterministic refusal and never enter the
model dispatch path. The keyword and hexadecimal token are case-insensitive.
Tokens stay out of tool results and business audit payloads.

Pending previews expire after five minutes, are consumed before execution, and are
lost on restart. Request a fresh preview after a restart or rollback; never restore
old pending state. A new action receives independent cryptographic randomness, so
replaying an old confirmation cannot practically match a later action, including
after restart. Backend pending-action claims continue to prevent repeated effects;
no automatic mutation retry is added. This is not a durable webhook deduplication
service: duplicate events may still produce repeated reads or unconfirmed previews.

Zoom webhook admission now requires a valid signature and a canonical Unix-seconds
header within five minutes of the server clock, allowing at most 30 seconds ahead.
These inclusive whole-second bounds are local policy. Keep gateway time synchronized;
outside the bounds, signed events are refused before dispatch. This admission policy
affects all bots on that Zoom listener. Other bots retain their existing confirmation
formats; ScopelyBot's token protection does not certify their approval paths.

Roll out only a reviewed, matched gateway/plugin build after isolated tests. Human
Zoom delivery, sender mapping, approval and reply audience must be verified on the
development channel before enabling writes. Production profiles remain read only.
The seven mapped write capabilities still have partial field coverage; this change
does not implement the remaining eleven historically used write-tool names.

### Native account and pricing discovery (P4)

`scopely_list_users` and `scopely_get_user` use the native identity reads. Active
platform administrators can inspect active or inactive targets across organizations.
Get accepts the exact native ID and retains its user header while paging actual
memberships. List searches up to ten AND terms across names, username and email;
there is no client retry or automatic choice between duplicate matches. Native
roles are stored facts, not effective authorization or write eligibility. Legacy
role filters, session counts/history and lockout dossier fields are unsupported.

Where explicit service-token or person-token capability allowlists are configured,
operators must grant `identity.users.list` and `identity.users.get`. Installing
descriptors or bot bindings alone does not provision access; the actual acting
user must still be an active platform administrator. This packet changes no remote
configuration or credentials.

Account pages preserve whole rows under the backend's complete 12,000-byte escaped
JSON budget; follow `next_offset` until null. The existing bot output cap preserves
the user header and adjusts continuation if it must truncate an unexpected larger
page. An oversized first row refuses with admin-inspection guidance. Search may
contain personal information under the existing audit policy.

`scopely_list_pricing_items` now reads the existing shared governing VIP rate card
using `vendor_key` and stable `pricing_key`, with the existing staff permission.
It does not promise project-specific rates, legacy numeric item IDs or calculated
quote totals. The older ZW pricing table remains separate. Unknown or obsolete fields
on these three bindings reach backend refusal unchanged when declared fields are valid.
Malformed whole arguments and invalid declared fields (including null filters) refuse
during preparation before a backend audit exists.

Backend P4 passed 577 local tests, including real REST/MCP inactive lookup into an
unchanged synthetic write preview. Bot transport tests use a mocked HTTP boundary;
human Claude/Zoom UAT, deployment and whole-workflow parity are separate gates.
Production business data remains read only.

The three strict discovery bindings also reject missing, null, array, or primitive whole-call arguments before host optional-object normalization. Use an explicit `{}` for an unfiltered user list. Object fields remain intact for validation; host schema refusal occurs before backend invocation and therefore does not create a backend audit row. Plugins returning preparation callbacks bypass descriptor-only caching so later resolutions retain that boundary and current requester context.

Strict discovery preparation validates raw values against the original native tool schema before host coercion: for example, boolean user IDs, numeric strings, and null filters refuse instead of selecting another account or scope. These local schema refusals do not invoke the backend or produce its audit row. Unknown fields remain unchanged and reach the backend's strict schema refusal when the declared fields are valid.

### Synthetic unused pricing removal (local only)

`scopely_delete_pricing_item` stages `pricing.items.delete` with exact native
`vendor_key` and `pricing_key`. Use `scopely_list_pricing_items` with
`scope_mode: "all"` to discover the key first. Only configured `ops-test-*`
vendors and `ops_test_*` keys qualify. Copy the human CONFIRM line only after
reviewing the full removed record and successor version. Declining confirmation
leaves the card unchanged; the backend also exposes `ops.cancel` in Claude.

This activates a shared platform successor omitting one unused plain key. It
preserves historical cards/entries and snapshots; it does not reproduce legacy
project override deletion or fallback. Any catalog reference (including retired
or tenant fields), dynamic options, vendor envelope/intake draft, tenant rate
card, imported history or rich target refuses. Old IDs are never silently mapped.

The isolated backend uses owner table locks and a domain lock-timeout cap of
250ms, honoring shorter limits. Busy operations refuse without retry; existing
kernel authorization waits are outside this cap. These coarse locks are not
approved for shared Noob/production rollout. Future writers can still create new
unresolved references after commit; this is transaction-time cleanup only.
Production stays read-only. Mocked Zoom transport and local native tests are
separate from actual connected-channel and human approval evidence.

### Confirmation failures and unknown outcomes

Only an intact successful backend response with durable `succeeded` state and
`reconcile_required: false` reports completion. Confirmed failed, cancelled or
expired states report that the change was not applied. Missing, malformed,
truncated, nonterminal or server-error responses cannot establish that result.
Timeouts and callback exceptions likewise report **Outcome unknown**: inspect
and reconcile the existing pending action and audit before a new request; do not
retry blindly. The consumed Zoom code never invokes its callback a second time.

Unknown confirmation audit entries use a fixed category. Arbitrary exception
text is not logged, even when it does not resemble a recognizable credential.
This is local automated evidence; a real human confirmation and deployed runtime
still require their own UAT. Production remains read only.
