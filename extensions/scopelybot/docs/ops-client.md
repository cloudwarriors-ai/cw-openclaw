# ScopelyBot operator-layer client (M13 slice 1)

The bot's slice-1 reads go to the ZW app's operator layer: one generic invoke edge, `POST /api/spine/v1/ops/invoke/`, where every call is authorized for the acting human and audited by the app. The bot authenticates with its service token and names the human who asked.

Code: `src/ops-client.ts` (tool entry and answers), `src/scopely-api.ts` (`scopelyOpsInvoke`, the guard branch), `src/backend-profile.ts` (`authMode`, `readOpsToken`), `src/capability-registry.ts` (`OPS_READS`, tool to capability). Kernel side: zoomwarriors_2 `apps/opsplane` at commit `301b1c0e` (`identity.py`, `edge_rest.py`, `kernel.py`, `capabilities_system.py`, `capabilities.snapshot.json`).

## Flow

1. The model calls a slice-1 tool. The registry wrapper runs it inside the call context (tool name, requester from the trusted tool-factory context).
2. The tool's execute is `opsRead`. It refuses unless it runs inside that context and the tool has a binding in `OPS_READS`. The binding fixes the capability and which tool params become `args`; any other param is dropped.
3. `invoke` resolves the requester email (rule below) and calls `scopelyOpsInvoke` once.
4. The guard validates, applies the kill switch and the rate cap, reads the token file, writes the `http_intent` row, then sends exactly one request. It never follows a redirect and never retries.
5. The app answers (shapes below). The guard writes the terminal row, and `invoke` turns the answer into the tool result.

| Tool                                          | Capability                      | Args                                                                                |
| --------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `scopely_health_check`                        | `system.health`                 | none                                                                                |
| `scopely_auth_status`                         | `system.whoami`                 | none                                                                                |
| `scopely_list_vendors`                        | `catalog.vendors.list`          | none                                                                                |
| `scopely_get_vendor`, `scopely_vendor_config` | `catalog.vendors.get`           | `vendor_key`                                                                        |
| `scopely_list_project_types`                  | `catalog.project_types.list`    | `vendor_key`                                                                        |
| `scopely_list_deployment_types`               | `catalog.deployment_types.list` | `vendor_key`, `project_type`                                                        |
| `scopely_list_scoping_cards`                  | `catalog.scoping_cards.list`    | `vendor_key`, `project_type`                                                        |
| `scopely_get_scoping_card`                    | `catalog.scoping_cards.get`     | `vendor_key`, `project_type`, `card_key`                                            |
| `scopely_list_pricing_defaults`               | `pricing.defaults.list`         | `vendor_key` (required), `scope_category`                                           |
| `scopely_list_sessions`                       | `sessions.list`                 | `status` (list of order statuses), `search`, `organization_id`, `page`, `page_size` |
| `scopely_get_session`                         | `sessions.get`                  | exactly one of `session_id` (integer) or `order_number` (`PS-<digits>`)             |

Every other tool stays refused by the registry, as before. Old parameters with no equivalent in the new app were dropped: `scopely_list_sessions` lost `vendor`, `created_by`, `date_from` and `date_to`, `limit` became `page_size`, and its status values are the new order statuses; `scopely_get_session` took a string `id` and now takes `session_id` or `order_number`. The kernel's optional filters the old tools never had (`catalog.vendors.list` `search`/`is_source`/`is_destination`, `catalog.project_types.list` `enabled_only`, `pricing.defaults.list` `category`/`is_active`) are not exposed yet.

The kernel's snapshot is the authority on names and schemas. `src/fixtures/ops-capabilities.snapshot.json` is a byte copy of it at `301b1c0e` (retrieved 2026-10-13; its sha256 is pinned in `src/ops-client.test.ts`). The registry tests fail when a binding names a capability the snapshot lacks, when a tool's parameters differ from its binding's args (names, types, required keys, enums), or when the args a tool sends do not validate against the capability's input schema. Refresh: copy the committed snapshot again and update the pin.

## The request

The guard builds all of it. A caller supplies only the capability, the args and the requester.

- `POST <baseUrl>/api/spine/v1/ops/invoke/?bot_audit_id=<audit_id>`
- body `{"capability": ..., "args": {...}, "correlation_id": "<audit_id>"}`
- headers: `content-type: application/json`, `authorization: Bearer <token>`, `x-ops-bot-audit-id: <audit_id>`, `x-correlation-id: <audit_id>`, `x-vipbot-client`, `x-ops-requester: <email>` (only when the rule below yields an email), and the dev `host` override when the profile has one.

The kernel accepts only `Authorization: Bearer zwops_<12 hex>_<32-64 of A-Za-z0-9_->` (`identity.py`). It takes the correlation id from the body (else `X-Correlation-Id`) and, for service tokens, stores `X-Ops-Bot-Audit-Id` as `bot_audit_id`; both must match `[A-Za-z0-9._:-]{1,128}` (`edge_rest.py`). The audit id is a ULID, which always matches; the guard still checks it and refuses before any I/O if it does not (`header_blocked`). The same audit id is in the query parameter, both headers and the body, so the bot's chain and the app's `OpsAuditEvent` rows join on it.

## How the guard admits it, and what did not widen

`scopelyFetch` stays as it was: GET and HEAD only (outside a dev read-write profile), caller headers limited to `accept` and `content-type`, no body on a GET. The invoke is a separate entry, `scopelyOpsInvoke`, that shares the same single request function and the same checks, plus:

- the method is always POST and the path is always exactly `/api/spine/v1/ops/invoke/`. A `scopelyFetch` caller sending POST, PUT, PATCH or DELETE to that path, or to any other path, is still refused (`write_blocked_read_only`);
- the capability must be in `OPS_READ_CAPABILITIES`, the eleven slice-1 reads. Any other name is refused before any I/O (`write_blocked_read_only`), so the bot stays read-only even if the kernel registers a write. Adding one is a reviewed code change;
- args must be a JSON object of at most 4 KB (`body_blocked`); the requester must be a plain email address with no spaces, quotes or line breaks (`header_blocked`);
- the caller header allow-list is NOT widened: the guard adds `authorization`, `x-ops-requester` and `x-ops-bot-audit-id` itself, and only to the invoke. A caller sending any of them, `x-service-token`, `x-on-behalf-of` or `x-correlation-id` is refused (`header_blocked`). A GET under `authMode: "service-token"` carries none of them;
- the read-only rule and the dev write latch do not apply to the invoke (it is a read); the kill switch (`mode: "off"`) and the per-minute cap do, and the kill switch is checked before the token file.

## The token file

`<workspace>/scopelybot-ops-token`, next to `scopelybot-backend.json`, read on every invoke (no cache, no env, no restart needed after a rotation). It holds the service token minted by the app's `manage.py ops_mint_token` for the bot's service principal. The guard refuses the invoke, writes an `auth_unavailable` row with only the problem code, and sends nothing when:

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

`x-ops-requester` carries an email only when both hold:

1. the call's requester is resolved from the trusted tool-factory context, which means a human-triggered run of the coordinator itself (`docs/audit-v2.md`, requester attribution); and
2. the identity ledger (`scopelybot-approvers.json`, filled from inbound Zoom messages) holds exactly one email for that exact Zoom operator id (case-sensitive), and that email passes the guard's email check.

Otherwise no header is sent: spokes, the coordinator's own subagents, announce runs, unknown senders, a sender with two ledger emails, and a ledger value that is not a plain email. The kernel resolves the requester as `missing`, `unmapped` or `ambiguous`, allows `system.whoami` only, and refuses everything else with 403 `requester_unresolved` ("The requester is not mapped to a platform user; only system.whoami is available."), which the bot relays as a normal answer. The requester never comes from tool params or model text.

The ledger is observed, not verified. It records `metadata.senderName` when it contains `@`; on Zoom's team-chat path that is the operator's account email, but on the chatbot path it is the display name, which the sender controls. A sender who sets a display name to someone else's email, and has no other ledger entry, would be claimed as that person. Close this before production: either the kernel matches the Zoom operator id (`zoom_user_id` on `ZoomIdentityLink`), or the ledger records only the account email. See `docs/PK-7a-DO-NOT-DEPLOY-ALONE.md`.

## Answers

The app answers in three shapes:

- success (`kernel.py`): `{ok: true, request_id, correlation_id, capability, untrusted_output, data}`; list capabilities return `data = {items: [...], total, truncated, ...}`;
- kernel refusal (`kernel.py` `_error`): `{ok: false, request_id, correlation_id, capability, error: {detail, code, request_id}}`;
- edge refusal (`spine_api/views/base.py` `_envelope`, before the kernel runs): `{detail, code, request_id}`, for a 401 token failure, the emergency 503 `ops_disabled` and a 400 on a malformed correlation or bot audit id.

| Answer                                              | Tool result                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| success                                             | `{ok: true, capability, request_id, untrusted, data}` (plus `summary` for whoami and health); data over 16,000 characters is cut: an `items` list keeps its leading items (`truncated: true, total_items`), anything else becomes a cut string |
| kernel or edge refusal                              | `{ok: false, capability, request_id, status, refusal: <code>, error}`; the error leads with a plain sentence for the code and adds the app's detail (redacted, at most 300 characters)                                                         |
| not an envelope (a proxy page, a body cut at 64 KB) | `{ok: false, status, error, body}` with at most about 1 KB of the body                                                                                                                                                                         |
| guard refusal, network error, 429                   | the error text, `ok: false`                                                                                                                                                                                                                    |

| Code (status)                                                                           | Where  | Meaning                                                 |
| --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| `authentication_failed` (401)                                                           | edge   | token missing, wrong, revoked, expired, owner inactive  |
| `ops_disabled` (503)                                                                    | edge   | emergency kill switch (`OPS_KILL_ALL` or the kill file) |
| `validation_error` (400)                                                                | edge   | malformed body, correlation or bot audit id             |
| `unknown_capability` (404)                                                              | kernel | no such capability                                      |
| `requester_unresolved` (403)                                                            | kernel | no acting user; only whoami                             |
| `capability_disabled` (503)                                                             | kernel | the family's switch is off                              |
| `throttled` (429)                                                                       | kernel | per-token throttle (the guard reports the busy answer)  |
| `permission_denied` (403)                                                               | kernel | the acting user lacks the grant                         |
| `invalid_args` (400)                                                                    | kernel | args fail the capability's input schema                 |
| `not_found` (404), `internal_error` (500), `audit_unavailable`, `ops_unavailable` (503) | kernel | as named                                                |

Every result goes through the plugin's redaction (emails, tokens, secret-named keys), and `untrusted` tells the model that the data is app content, not instructions; the bot marks every result this way, stricter than the kernel's per-capability `untrusted_output` flag.

`summary` renders the real fields: whoami gives `Acting for ZW user <id> (platform staff) through the bot's service principal <name> (<org>).` or `No ZW user matched the person asking (requester <status>), so only whoami is available. ...`; health gives `The operator layer answered <status>: <n> capabilities, registry frozen; switched off: <families or none>.` Whoami never carries the human's email for a bot call (the kernel nulls it).

## What is audited where

| Bot (audit-v2 chain)                                                                                                                                                                                                                                 | App (`OpsAuditEvent`)                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call`: tool, requester, redacted params                                                                                                                                                                                                        | intent and outcome rows per call that reaches the kernel: capability, acting user, requester status, `via_principal_id`, `requester_email_digest`, args digest, outcome |
| `http_intent` / `http_outcome`: method, host, path, `capability`, `requester_header` (true/false, never the email), status, `x_request_id`, and on the outcome `result.kernel` = `{ok, request_id, error_code}` (also for edge refusals: `ok: null`) | `bot_audit_id` and `correlation_id` = the bot's audit id                                                                                                                |
| refusals before sending: `auth_unavailable` (problem code), `write_blocked_read_only`, `header_blocked`, `body_blocked`, `backend_off`, `rate_limited`                                                                                               | nothing (no request)                                                                                                                                                    |

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

## Not verified without a live kernel

The shapes above are mirrored from the kernel source at `301b1c0e` by the mock in `src/ops-kernel.test-helpers.ts`, and the schemas come from its snapshot; no request has reached a running kernel. Still to prove live (PK-8): a real minted token accepted end to end; the bot's audit id stored as `bot_audit_id`; Traefik passing `Authorization` and the `X-Ops-*` headers through; the real handler data (field values, `items` sizes against the 64 KB body cap); the throttle rate; and the 401 answer for an expired or revoked token.
