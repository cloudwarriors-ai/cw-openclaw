# ScopelyBot paired changeover

Install the reviewed backend and matched gateway together, initially read only. This document describes gates; the release owner's private packet supplies actual hosts, identities, images and commands. It is not deployment or write authorization.

## Reviewed scope

The initial business tools create/update native pricing items; create/update/delete scoping cards; and update project/deployment metadata. All use the same backend staging → exact frozen preview → human confirmation → one-time execution path. API and MCP share that kernel. Other historical writes and full Django admin parity remain separate work.

Native prices feed the VIP quote engine; the older BasePricing table is not the bot's pricing authority. Verify a calculated quote and preserved saved history, not only a rate list. Priced questions/options cannot be removed, retyped, retired or rebound through ordinary scoping replacement/deletion.

## Before integration

1. Obtain required PR reviews, combined checks and release-owner scope approval. Coordinate the change record: new migrations, private routing and bot configuration must be explicitly included.
2. Verify an effective deployment lock before promotion. A billing/account failure is not a deployment lock. The production workflow must be explicitly disabled and its production gate set false, then verified by the owner. Do not enable or dispatch workflows as part of preparation.
3. Preserve stacked PR dependencies. Reconcile/rebase deferred work and move useful deltas before closing a superseded foundation. Never delete the branches during cleanup.
4. Test reset/lockout/login and refresh against the actual combined source. Same-origin multi-tab refresh requires Web Locks in a secure browser context; lack or failure of that lock refuses refresh rather than sending an unlocked request. Server token-reuse detection remains intact. Different origins do not share browser locks; host-only auth cookies remain required.

## Build and install

1. Use one reviewed digest-pinned image recipe for backend, workers and scheduler, with the same source identity. Preserve the frontend's release-specific build arguments. Build the full matched gateway host revision; replacing only a plugin does not prove host SDK compatibility.
2. Capture backups and prove isolated restoration. Run migration planning from the **new** image using a one-off container without public routing; planning inside the old running container misses new migrations. Apply the reviewed plan once before normal startup; startup migration must be a no-op afterward.
3. Add the public operator-route denial before exposing the new operator endpoints. Verify the exact private Host, TLS, intended-client and denied-client access. Preserve all existing routing and private Serve entries.
4. Provision scoped app credentials, verified Zoom-user links and the exact current approver roster. Existing chat membership or native admin accounts do not create those links/roster entries automatically. Keep the service credential exclusive to the trusted Zoom gateway; a person client uses its own credential.
5. Review the actual bot agent's `tools.allow`: a health-only list cannot read prices or stage changes. Add only selected reads and launch writes; do not enable all historical tools. Preserve the existing channel and all other bots' bindings. Assert exactly one approved channel binding and no DM route into this agent.
6. Configure runtime-owned persistent audit/code storage and `SCOPELYBOT_CONFIRM_CODE_DIR`. Verify the actual production UID and mount. Back up dirty live compose/config files; never overwrite them with a repository copy. Coordinate any shared gateway restart.
7. Start with backend and bot business writes off. Confirm the effective parsed profile described in `backend-profile.md`, rather than assuming a file edit reached the running process.

## Small acceptance and separate bot go/no-go

Verify normal app login/reset/admin access and the app release's existing smoke tests. Then verify private API/MCP reads, credential/public/ACL refusals, actual Zoom sender attribution, a readable bot response and write refusal in the original channel.

Bot activation can slip without blocking the main application release. Only after write fixes/reviews, explicit authority-policy acceptance and a selected isolated vendor/quote may the owner enable the approved families and matched profile. Run one human-approved change; inspect quote/history/audit and replay protection; record feedback. No safe target or failed gate means keep the bot read only.

Production Core7 writes require the configured gateway principal, verified Zoom sender and current confirmer roster. Direct person tokens cannot stage or confirm production writes; their authorized reads remain available. A rostered requester may confirm their own change. Claude production writes are deferred. The bot service credential can assert a linked Zoom sender; it is therefore a trusted-gateway credential, not a general user token. Those policies require owner acceptance before production activation. Private networking alone does not authenticate an individual human.

## Freeze and rollback

Disable business writes and withdraw only the owned private entrance as needed. Attempt each containment action even if another fails. Preserve public denial, other services, audit/pending records and every latest code reservation. Reconcile uncertain claims before a new request; never automatically retry the mutation.

Restore only the reviewed compatible code/image/config pair. Forward additive migrations may remain when older code ignores their tables/nullable column; verify this for the actual combined release. Do not automatically reverse populated migrations or restore a database over newer writes. Database recovery is a separate decision.

The offline `preflight-readonly.ts` check requires the reviewed private production origin, service-token auth, read-only mode and productionCoreWrites disabled in its explicit template inputs. It neither verifies this production procedure nor grants deployment readiness. Current live/private evidence, operator inputs and go/no-go remain in the private release packet; no private security patch or credentials belong in this public repository.

## Shared gateway clock and delivery acceptance

The timestamp freshness fence applies to every bot on the gateway. Before any
restart, verify host clock synchronisation and measured clock error comfortably
within the30-second future allowance; retain evidence and monitoring. Signature,
malformed timestamp, expired timestamp and future timestamp refusals have distinct
bounded log reasons. No headers, signing secrets or payloads are logged.

The policy remains300seconds old and30seconds future. It checks the HMAC-signed
request-header timestamp, not the event's original event_ts. [Zoom documents](https://developers.zoom.us/docs/api/webhooks/)
three retry intervals:5minutes, then20minutes, then60minutes. Those docs do not
promise whether a retry reuses or refreshes its signed header timestamp. Local
fixtures prove freshly signed old events can dispatch; they do not establish
provider retry behavior. Test a genuine retried delivery and other bots on the
matched gateway in the dedicated window. Do not widen the replay window or relax
signature checks to guess around a failed retry. Freeze on unexplained drops.

This bot release has its own CAB/window. It does not amend the separate approved
application release, its schema assumptions, cleanup approvals or deployment lock.
