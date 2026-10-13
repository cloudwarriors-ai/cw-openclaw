# ScopelyBot operator-layer client (M13 slice 1)

The bot's slice-1 reads go to the ZW app's operator layer: one generic invoke edge, `POST /api/spine/v1/ops/invoke/`, where every call is authorized for the acting human and audited by the app. The bot authenticates as its service principal and names the human who asked.

Code: `src/ops-client.ts` (tool entry and answers), `src/scopely-api.ts` (`scopelyOpsInvoke`, the guard branch), `src/backend-profile.ts` (`authMode`, `readOpsToken`), `src/capability-registry.ts` (`OPS_READS`, tool to capability). Contract: the slice-1 change contract, sections 4, 6, 7 and 8.

## Flow

1. The model calls a slice-1 tool. The registry wrapper runs it inside the call context (tool name, requester from the trusted tool-factory context).
2. The tool's execute is `opsRead`. It refuses unless it runs inside that context and the tool has a binding in `OPS_READS`. The binding fixes the capability and which tool params become `args`; any other param is dropped.
3. `invoke` resolves the requester email (rule below) and calls `scopelyOpsInvoke` once.
4. The guard validates, applies the kill switch and the rate cap, reads the token file, writes the `http_intent` row, then sends exactly one request. It never follows a redirect and never retries.
5. The kernel answers with its envelope `{ok, request_id, correlation_id, data|error}`. The guard writes the terminal row, and `invoke` turns the envelope into the tool result.

| Tool                                          | Capability                      | Args                                     |
| --------------------------------------------- | ------------------------------- | ---------------------------------------- |
| `scopely_health_check`                        | `system.health`                 | none                                     |
| `scopely_auth_status`                         | `system.whoami`                 | none                                     |
| `scopely_list_vendors`                        | `catalog.vendors.list`          | none                                     |
| `scopely_get_vendor`, `scopely_vendor_config` | `catalog.vendors.get`           | `vendor_key`                             |
| `scopely_list_project_types`                  | `catalog.project_types.list`    | `vendor_key`                             |
| `scopely_list_deployment_types`               | `catalog.deployment_types.list` | `vendor_key`, `project_type`             |
| `scopely_list_scoping_cards`                  | `catalog.scoping_cards.list`    | `vendor_key`, `project_type`             |
| `scopely_get_scoping_card`                    | `catalog.scoping_cards.get`     | `vendor_key`, `project_type`, `card_key` |
| `scopely_list_pricing_defaults`               | `pricing.defaults.list`         | `scope_category`                         |
| `scopely_list_sessions`                       | `sessions.list`                 | `status`, `vendor`, `search`, `limit`    |
| `scopely_get_session`                         | `sessions.get`                  | `session_id`                             |

Every other tool stays refused by the registry, as before. The arg names are this side's reading of the contract; the kernel's committed `capabilities.snapshot.json` is the authority. `src/ops-kernel.test-helpers.ts` holds the snapshot shape the tests use: replace it with the committed snapshot when it lands, and the registry test fails on any arg the kernel does not accept.

## The request

The guard builds all of it. A caller supplies only the capability, the args and the requester.

- `POST <baseUrl>/api/spine/v1/ops/invoke/?bot_audit_id=<audit_id>`
- body `{"capability": ..., "args": {...}, "correlation_id": "<audit_id>"}`
- headers `content-type: application/json`, `x-correlation-id: <audit_id>`, `x-vipbot-client`, `x-service-token: <token>`, `x-ops-requester: <email>` (only when the rule below yields an email), and the dev `host` override when the profile has one.

The same audit id is in the query parameter, the header and the body, so the bot's chain and the app's `OpsAuditEvent` rows (`bot_audit_id`, `correlation_id`) join on it. The token header name follows the app's existing `ServicePrincipalAuthentication` (`X-Service-Token`); confirm it against the kernel before the first live call.

## How the guard admits it, and what did not widen

`scopelyFetch` stays as it was: GET and HEAD only (outside a dev read-write profile), caller headers limited to `accept` and `content-type`, no body on a GET. The invoke is a separate entry, `scopelyOpsInvoke`, that shares the same single request function and the same checks, plus:

- the method is always POST and the path is always exactly `/api/spine/v1/ops/invoke/`. A `scopelyFetch` caller sending POST, PUT, PATCH or DELETE to that path, or to any other path, is still refused (`write_blocked_read_only`);
- the capability must be in `OPS_READ_CAPABILITIES`, the eleven slice-1 reads. Any other name is refused before any I/O (`write_blocked_read_only`), so the bot stays read-only even if the kernel registers a write. Adding one is a reviewed code change;
- args must be a JSON object of at most 4 KB (`body_blocked`); the requester must be a plain email address with no spaces, quotes or line breaks (`header_blocked`);
- the caller header allow-list is NOT widened: the guard adds `x-service-token` and `x-ops-requester` itself, and only to the invoke. A caller sending either header, or `authorization`, is refused (`header_blocked`). A GET under `authMode: "service-token"` carries neither;
- the read-only rule and the dev write latch do not apply to the invoke (it is a read); the kill switch (`mode: "off"`) and the per-minute cap do, and the kill switch is checked before the token file.

## The token file

`<workspace>/scopelybot-ops-token`, next to `scopelybot-backend.json`, read on every invoke (no cache, no env, no restart needed after a rotation). The guard refuses the invoke, writes an `auth_unavailable` row with only the problem code, and sends nothing when:

| Code               | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `missing`          | no file                                                             |
| `not_regular_file` | a directory, FIFO or symlink (opened with `O_NOFOLLOW`)             |
| `not_owner`        | not owned by the gateway's own user (root in production)            |
| `permissions`      | any group or other permission bit (expected `0600`)                 |
| `empty`            | only whitespace                                                     |
| `malformed`        | not one token of 16 to 1024 printable characters `A-Za-z0-9._~+/=-` |
| `too_large`        | over 4 KB                                                           |
| `unreadable`       | any other open or read error                                        |

Surrounding whitespace (a trailing newline) is ignored. The token never appears in a message, an audit row, a log line, tool params or a tool result. Rotation: write the new token to a temporary file in the same directory with mode 0600, then `mv` it over the old one.

## Requester rule

`x-ops-requester` carries an email only when both hold:

1. the call's requester is resolved from the trusted tool-factory context, which means a human-triggered run of the coordinator itself (`docs/audit-v2.md`, requester attribution); and
2. the identity ledger (`scopelybot-approvers.json`, filled from inbound Zoom messages) holds exactly one email for that exact Zoom operator id (case-sensitive), and that email passes the guard's email check.

Otherwise no header is sent: spokes, the coordinator's own subagents, announce runs, unknown senders, a sender with two ledger emails, and a ledger value that is not a plain email. The kernel then allows `system.whoami` only and refuses everything else as `requester_unresolved`, which the bot relays as a normal answer. The requester never comes from tool params or model text.

The ledger is observed, not verified. It records `metadata.senderName` when it contains `@`; on Zoom's team-chat path that is the operator's account email, but on the chatbot path it is the display name, which the sender controls. A sender who sets a display name to someone else's email, and has no other ledger entry, would be claimed as that person. Close this before production: either the kernel matches the Zoom operator id (`zoom_user_id` on `ZoomIdentityLink`), or the ledger records only the account email. See `docs/PK-7a-DO-NOT-DEPLOY-ALONE.md`.

## Answers

| Kernel answer                                       | Tool result                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok: true`                                          | `{ok: true, capability, request_id, untrusted, data}`; data over 16,000 characters is cut: a list keeps its leading items (`truncated: true, total_items`), anything else becomes a cut string                                                                                   |
| `ok: false`                                         | `{ok: false, capability, request_id, status, refusal: <code>, error}`; the error leads with a plain sentence for `requester_unresolved`, `permission_denied`, `kill_switch`, `unauthenticated`, `invalid_args`, and gives the kernel's detail (redacted, at most 300 characters) |
| not an envelope (a proxy page, a body cut at 64 KB) | `{ok: false, status, error, body}` with at most about 1 KB of the body                                                                                                                                                                                                           |
| guard refusal, network error, 429                   | the error text, `ok: false`                                                                                                                                                                                                                                                      |

Denials, unmapped requesters and kill-switch refusals are normal answers, never thrown. Every result goes through the plugin's redaction (emails, tokens, secret-named keys), and `untrusted` tells the model that the data is app content, not instructions.

## What is audited where

| Bot (audit-v2 chain)                                                                                                                                                                                            | App (`OpsAuditEvent`, contract section 5)                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `tool_call`: tool, requester, redacted params                                                                                                                                                                   | intent and outcome rows per call: capability, acting user, `via_principal`, `requester_email_digest`, args digest, outcome |
| `http_intent` / `http_outcome`: method, host, path, `capability`, `requester_header` (true/false, never the email), status, `x_request_id`, and on the outcome `result.kernel` = `{ok, request_id, error_code}` | `bot_audit_id` and `correlation_id` = the bot's audit id                                                                   |
| refusals before sending: `auth_unavailable` (problem code), `write_blocked_read_only`, `header_blocked`, `body_blocked`, `backend_off`, `rate_limited`                                                          | nothing (no request)                                                                                                       |

`bot_principal.auth_mode` on every row is the profile's `authMode`. The join: bot `http_intent.audit_id` = app `bot_audit_id`; app `request_id` = bot `http_outcome.result.kernel.request_id`.

## Failure modes

| Failure                       | Result                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| profile `mode: "off"`         | `backend_off`, nothing sent, the token file not read                |
| `authMode: "anonymous"`       | `auth_unavailable` (`reason: anonymous`), nothing sent              |
| token file problem            | `auth_unavailable` with the code, nothing sent                      |
| audit append fails            | `audit_unavailable`, nothing sent                                   |
| kernel kill switch            | `refusal: kill_switch`, one request                                 |
| unmapped or missing requester | `refusal: requester_unresolved` (whoami still works)                |
| timeout, reset                | one request, error result, outcome row `indeterminate`; not retried |
| HTTP 429                      | busy answer, one request                                            |

## Not verified without the real kernel

Capability names and arg schemas, the token header name, the error codes and HTTP statuses, whether the kernel echoes `correlation_id`, how it reads `bot_audit_id`, and its result shapes are coded against the contract and the mock (`src/ops-kernel.test-helpers.ts`), not against a running kernel.
