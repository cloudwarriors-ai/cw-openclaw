# ScopelyBot audit-v2 (PK-7b-1)

The bot's audit log is one append-only, hash-chained file per workspace: `<workspace>/scopelybot/audit-v2.jsonl`. Every audit row the plugin writes goes there. Nothing writes the v1 `scopelybot/audit.jsonl` any more; v1 is only read once, to cite it in the first record.

Code: `src/audit-chain.ts` (chain and writer), `src/audit.ts` (row producers), `src/scopely-api.ts` (request rows and correlation), `src/call-context.ts` (requester). Independent verifier: `scripts/verify-audit-chain.mjs`.

## Record

One JSON object per line, in canonical form (keys sorted by UTF-16 code unit, no whitespace, integers only). `schema_version` is `2`.

| Field                                              | Meaning                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`, `seq`, `ts`, `prev_hash`, `hash` | Chain fields. `seq` starts at 1 and goes up by exactly 1. `ts` is wall-clock time, informational only (order is `seq`).                                                                                                                                                                                                                            |
| `audit_id`                                         | 26-character ULID. One per HTTP request, shared by its intent and outcome rows (and sent to the app); otherwise one per row.                                                                                                                                                                                                                       |
| `event_type`                                       | Closed list, below.                                                                                                                                                                                                                                                                                                                                |
| `phase`                                            | `intent`, `outcome` or `single`.                                                                                                                                                                                                                                                                                                                   |
| `trigger`                                          | `tool`, `confirm`, `hook` or `startup`.                                                                                                                                                                                                                                                                                                            |
| `env`, `plugin_version`, `bot_principal`           | The profile's `env` (`unknown` under the fail-closed default), the plugin version, and the bot identity: `auth_mode` is the profile's `authMode` (`anonymous` or `service-token`, never the token), no principal id.                                                                                                                               |
| `policy`                                           | `state` (`valid` or `fail_closed_default`), `mode`, `profile_sha256` (sha256 of the profile file, null when there is none).                                                                                                                                                                                                                        |
| `requester`                                        | Who asked: `resolved`, `zoom_operator_id`, `source` (`ctx`, `before_dispatch`, `none`) and `reason` (`missing`, `announce_run`, `system`, or null when resolved).                                                                                                                                                                                  |
| `approver`                                         | CONFIRM rows only: the person who typed CONFIRM.                                                                                                                                                                                                                                                                                                   |
| `openclaw`                                         | `agent_id`, `session_key`, `tool_call_id` of the tool call.                                                                                                                                                                                                                                                                                        |
| `action`                                           | `tool`, `family`, `op_class` (`read`, `write`, `non_api`, `unknown`), `registry_status`; on `tool_call` rows also `params_redacted` and `params_sha256`.                                                                                                                                                                                           |
| `http`                                             | `method`, `host`, `path_template` (id-like segments become `:id`), `query_keys` (names only, never values), `status`, `x_request_id`, `duration_ms`; `deadline_ts` on intents; `redirect_to_host` on a refused redirect; on operator-layer invokes also `capability` and `requester_header` (whether `X-Ops-Requester` was sent; never the email). |
| `result`                                           | `status` (`ok`, `http_error`, `error`, `indeterminate`, `not_sent`, `blocked`, `staged`) plus `reason` / `error_class`; on an operator-layer outcome also `kernel` = `{ok, request_id, error_code}` from the app's envelope (charset checked).                                                                                                     |
| `detail`                                           | Per-event extra values: scalars of at most 256 characters, redacted.                                                                                                                                                                                                                                                                               |
| `v1`                                               | Epoch marker only: the frozen v1 file.                                                                                                                                                                                                                                                                                                             |
| `recovery`                                         | Recovery rows only: `intent_seq`, `intent_ts`.                                                                                                                                                                                                                                                                                                     |
| `repaired_torn_lines`                              | The `bytes` and `sha256` of each torn fragment this row closes.                                                                                                                                                                                                                                                                                    |

Event types: `epoch_marker`, `policy_change`, `audit_gap`, `http_intent`, `http_outcome`, `backend_off`, `write_blocked_read_only`, `write_blocked_unattributed`, `host_blocked`, `header_blocked`, `body_blocked`, `redirect_blocked`, `rate_limited`, `auth_unavailable`, `not_available`, `tool_call`, `confirm_ok`, `confirm_error`, `confirm_denied`, `confirm_expired`, `approver_change`, `inbound_block`, `inbound_flag`, `supervisor`, `digest_skipped`. In PK-7b-1, `write_blocked_unattributed`, `confirm_denied`, `confirm_expired` and `approver_change` have no producer yet (PK-7b-2).

Never stored: message bodies, CONFIRM codes, tokens (the operator-layer service token included), cookies, auth headers, requester emails, request and response bodies, query values, the redirect `Location` value. Email addresses are not stored. Tool params are stored redacted (`params_redacted`); `params_sha256` is the sha256 of the canonical redacted params, so it is never a hash of a secret and survives when an oversized row drops `params_redacted`. Redaction cuts every longer string to its first 200 characters before hashing, so params that differ only after character 200 hash equal. A row over 8 KB drops `params_redacted`; a row over 16 KB is refused.

Values supplied by the host or by the app's response (the session key, agent id and tool call id, the requester id, query key names, the redirect host) are bounded when captured: at most 253 characters, a longer value kept as a 240-character prefix plus `~` and 12 hex of its sha256. None of them can push a row over the 16 KB cap.

## Chain and epoch marker

`hash = sha256(prev_hash + "\n" + canonical JSON of the record without hash)`. The stored line must equal the canonical form of its record byte for byte, so any edit, whitespace or key-order change is detectable.

The first record is an `epoch_marker` (`seq` 1, `prev_hash` 64 zeros, `detail.reason` `cutover_v1`) whose `v1` field holds the frozen v1 file's `sha256`, `bytes`, `lines` and `last_ts`, computed when the chain starts (`exists: false` when there is no v1 file). The v1 file must be a regular file of at most 8 MiB; a larger, symlinked or unreadable v1 fails the first append (so no request is sent) rather than be misrecorded. The value for production is whatever that host's v1 file hashes to at cutover; PK-9 compares it against the off-host PK-1 archive with `--v1-file` or `--v1-sha256` (below). Because the marker cites v1's hash at the first v2 append, v1 must be frozen (final snapshot taken, `chattr +i`) before the first v2 append; a v1 still being written when the chain starts makes the marker cite a file that no longer matches the archive.

What the chain proves, against someone without the off-host anchor: no single-byte edit, interior deletion, reorder, insertion or partial-line truncation goes unnoticed. It does not detect a whole-line tail deletion or a fully rewritten chain with recomputed hashes: anyone who can write the file can rewrite all of it. With a trustworthy off-host anchor, everything up to the anchored `seq` is committed. It never proves that the plugin logged everything (a direct request from the container is only caught by the proxy log), that the content is truthful, that `ts` is truthful, or confidentiality. Tamper-evident, not tamper-proof: the off-host anchor and `chattr +a` make it strong.

## Writer

The whole append is synchronous: take the lock, re-read the tail from the file, check it, write, `fsync`, release. In-process appends cannot interleave, and correctness never depends on memory: every append re-reads the last 64 KB of the file. The file is only opened to append or to read (never truncated, renamed or deleted), so it works under `chattr +a`. Every open refuses a symlink (`O_NOFOLLOW`) and never blocks (`O_NONBLOCK`, then the opened file must be a regular file): a symlink, FIFO or directory at the audit or v1 path fails the append (`INTEGRITY`), and a unix socket there fails it too (`IO`, because the open itself is refused), instead of writing through the link or hanging the gateway.

- Lock: `audit-v2.lock` beside the file, created exclusively. A lock older than 10 s is taken over; otherwise up to 5 retries of 20 ms, then the append fails (`LOCK`). Anything other than a regular file at the lock path (a directory, a symlink) fails every append (`LOCK`, "not a regular file"). This guards other processes only and is advisory.
- Tail check: the last record must verify (canonical form, `schema_version` 2, hash) and link to the nearest record before it, skipping repaired fragments. If it does not, the append fails (`INTEGRITY`) and keeps failing: the writer never extends a chain it can see is broken. A writer that has written before also refuses an emptied or vanished file.
- Torn tail (crash or disk full mid-line): the next append closes the fragment with `\n` and cites it in `repaired_torn_lines` (up to 8 fragments and 64 KB; more is `INTEGRITY`).
- Gap: after failed appends, the next successful append by the same process first writes an `audit_gap` row (`from_ts`, `to_ts`, `failures`, `refused_requests`, `error_code`). The failure count is held in memory: if the gateway restarts before a successful append, the rows that were refused leave no `audit_gap` row.
- Recovery: a writer scans the last 1 MB for `http_intent` rows with no terminal row on its first append, and again on every later append while an intent that first scan found open, or one a failed append may have left open, is still inside its deadline (so a crash followed by a restart within 15 s is still recorded). The re-scan stops at the first append that finds no intent inside its deadline, the process's own live requests included. Each intent whose `deadline_ts` has passed gets one `http_outcome` with `result.status: indeterminate`, `reason: crash_recovery`. An orphan is recorded only by such an append after its deadline: an idle bot writes nothing, and until then `verify-audit-chain.mjs --require-paired` reports the intent as unpaired.
- Cost: about 4-5 ms per append with `fsync` on macOS APFS (0.2 ms without), unmeasured on the production Docker bind mount. Each app request writes 2 rows and its tool call 1; the event loop is blocked for that time, plus at most 5 x 20 ms of lock back-off.

## Audit before every request (INV-15)

`scopelyFetch` (the single choke point) validates the request first; a refusal there writes one row (`host_blocked`, `header_blocked`, `body_blocked`, `backend_off`, `write_blocked_read_only`, `rate_limited`, and for an operator-layer invoke `auth_unavailable`) and no intent, and nothing is sent. A validated request then:

1. gets an `audit_id` and an `http_intent` row, appended and fsynced. If that append fails, the request is not sent: the caller gets `Request not sent: the audit log is unavailable.` (`audit_unavailable`) and the per-minute slot is not spent;
2. is sent exactly once (no retry anywhere), with a 10 s timeout covering the body read;
3. gets exactly one terminal row with the same `audit_id`: `http_outcome` (`ok`, `http_error`, `error` with `error_class: body_read`, `not_sent` for DNS or refused connections, `indeterminate` for timeouts, resets and anything else), `redirect_blocked` for a 3xx, or `rate_limited` for a 429.

An intent's `deadline_ts` is 15 s after it is written, past the 10 s bound on the request and body read. If the outcome row cannot be written, the answer is still returned (the read happened), stderr gets `[scopelybot-audit] audit_degraded <code>`, and the recovery sweep later records the intent as `indeterminate`. Under a dev read-write profile, a failed outcome row of a mutating request also refuses further mutating requests until restart.

## Correlation (INV-5)

Every request carries the `audit_id` three ways, all set by the guard after every caller input:

- query parameter `bot_audit_id=<audit_id>` (set, so it appears exactly once; a caller value is overwritten);
- header `x-correlation-id: <audit_id>`;
- header `x-vipbot-client: scopelybot/<version> (<env>)`.

Callers still cannot send any header outside `accept` and `content-type` (a caller `X-Correlation-ID` is `header_blocked`). The request URL is the profile's origin plus a single-slash path, and its host is checked against `allowedHosts` (no userinfo) before the parameter is set; setting a query parameter cannot change the origin. Rows store `query_keys` without `bot_audit_id` and never values. The response's `x-request-id` is stored only when it matches `^[A-Za-z0-9._:-]{1,128}$`, else null. The query parameter is the load-bearing channel (the proxy logs paths; header capture is PK-16). Join: proxy line `RequestPath` contains `bot_audit_id` -> intent row -> outcome row (`x_request_id` from the app).

## Requester attribution (PK-7b-1: ctx only)

The requester comes from the trusted tool-factory context the host passes when it builds the tools for a run, captured by the registry wrapper for every tool call (including refusals):

- a coordinator session (`agent:scopelybot:...`, not a subagent) with `requesterSenderId`: resolved, `source: ctx`;
- a coordinator session without a sender: `resolved: false`, `reason: announce_run` (announce and completion runs, and also heartbeat, cron or operator headless runs);
- anything else (spoke sessions, the coordinator's own subagents, other agents, tools without a factory context): `resolved: false`, `reason: missing`.

It is never the bot and never read from tool params or model text. Rows written outside a tool call (policy, digest, supervisor) carry `reason: system`; inbound-guard rows carry the trusted `before_dispatch` sender.

## Known limits

- Spokes and the coordinator's own subagents carry no sender (probe S0), so any HTTP row they write is `missing`, and their operator-layer invokes carry no requester (the app answers whoami only). The slice-1 client relies on none of them being able to run the slice-1 tools (see `docs/PK-7a-DO-NOT-DEPLOY-ALONE.md`).
- AC-9.5's `inbound_message_id`, and `run_id` and `parent_session_key`, are not recorded in PK-7b-1. The accepted join from a Zoom message to its rows is `session_key` + `tool_call_id` + timestamps + the requester's sender id. PK-7b-2 adds `run_id`.
- Spoke attribution (spawn-label stamp with a `subagent_spawned` cross-check), confirm/approver rows and the unattributed-write refusal are PK-7b-2.
- If a second person posts while a run is active, the run's sender is the first person; PK-7b-2 adds a recorded flag for that.
- One appended byte makes the whole log unusable until a reseal: a trailing `\n` (a blank line), `\r`, or a complete non-record line such as `1\n` makes the tail `INTEGRITY` on every later append, so every request is refused. `chattr +a` does not prevent appends, so it does not prevent this; whoever can append to the file can also switch the bot off through the profile file. The remedy is the reseal runbook below.
- The writer's tail check cannot see everything the verifier sees. When the head is the first line of the 64 KB tail window, its link to the previous record is not checked; and a file whose only record is forged is extended without a genesis check (`seq` 1, zero `prev_hash`). The chain is unkeyed, so anyone who can append can already forge a correctly linked record; the verifier reports both cases (`bad_seq` or `bad_prev_hash`, `bad_genesis`), and off-host anchors are the control.
- Deferral candidates kept in 7b-1, to revisit later: the dev-only write latch (`writesLatched`, inert in read-only production; PK-13) and the verifier's `--prev-hash`/`--first-seq` (no rotation exists yet).

## Acceptance gate (Q1)

Reads whose requester cannot be resolved are recorded, never blocked. The gate for each test window (PK-8) and the deploy window (PK-9): 0 rows with `requester.resolved: false` among the window's `http_intent` rows that came from a tool call (`trigger: tool`).

## Verifier

```sh
node scripts/verify-audit-chain.mjs <file> [--anchor <last_seq>,<head_hash> | --anchor-file <json>] \
  [--v1-file <path>] [--v1-sha256 <hex>] [--prev-hash <hex> --first-seq <n>] \
  [--allow-torn-tail] [--require-paired] [--emit-anchor] [--json]
```

Exit `0` verified, `1` failed (prints the first bad `seq` and a reason: `bad_json`, `non_canonical`, `bad_hash`, `bad_prev_hash`, `bad_seq`, `bad_genesis`, `bad_schema`, `torn_tail`, `unexplained_garbage`, `anchor_missing_seq`, `anchor_mismatch`, `anchor_file_mismatch`, `v1_mismatch`, `unpaired_intent`), `2` usage or read error. `--emit-anchor` prints the anchor for the verified head: `{"anchor_version":1,"env",...,"first_seq","last_seq","head_hash","bytes","file_sha256","ts"}`. An anchor is a prefix commitment: a longer chain still verifies; a shorter or rewritten one does not. A torn last line fails unless `--allow-torn-tail`; an intent without a terminal row is a warning unless `--require-paired`.

## Failure modes

| Failure                                                        | What happens                                                                                          | Rows                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Disk full, read-only, permission error on the intent           | No request; `audit_unavailable` reply; stderr `audit_degraded`                                        | none; `audit_gap` on the next good append by the same process |
| Partial write (disk full mid-line)                             | Next append closes and cites the fragment                                                             | `repaired_torn_lines`                                         |
| Outcome row fails                                              | Answer returned; stderr `audit_degraded`; dev writes latched                                          | intent only, then a recovery row after the deadline           |
| Timeout, reset, abort                                          | One request, no retry                                                                                 | `http_outcome indeterminate`                                  |
| Process killed between intent and outcome                      | The first append after the deadline writes the recovery row, also after a restart inside the deadline | `http_outcome indeterminate, crash_recovery`                  |
| Edited, inconsistent, emptied or vanished tail; one stray byte | Every append fails, so every request is refused                                                       | none                                                          |
| Symlink, FIFO or directory at the audit or v1 path             | Every append fails (`INTEGRITY`), without hanging                                                     | none                                                          |
| Unix socket at the audit or v1 path                            | Every append fails (`IO`), without hanging                                                            | none                                                          |
| Lock-token write fails (disk full)                             | That append fails; the empty lock file it created is removed                                          | none                                                          |
| Lock held by a live writer for 100 ms                          | That append fails (requests refused, other rows lost with stderr)                                     | none                                                          |
| A directory or symlink at the lock path                        | Every append fails (`LOCK`, "not a regular file")                                                     | none                                                          |

## Operator reseal runbook (tail fails verification)

All app requests are refused while the tail does not verify (owner decision Q3). To restore service:

1. Stop the gateway, or set `"mode": "off"` in the backend profile. Either way the gateway must be restarted in step 5: a running process that has written to the chain refuses a moved or replaced file ("disappeared while in use").
2. Copy `audit-v2.jsonl` off the host as evidence and record its sha256.
3. Run the verifier with `--json` against the last good anchor to find the first bad `seq` and reason.
4. Move the broken file aside under a dated name (`audit-v2.jsonl.sealed-<date>`) with `chattr -a` first where it is set; keep it. Check `audit-v2.lock` beside it: if it is a directory or symlink, or a regular file left by a crashed process, remove it (a regular file older than 10 s is taken over automatically; anything else fails every append with `LOCK`).
5. Restart the gateway (and set `"mode": "read-only"` again if you switched it off). The first append starts a fresh chain. Its genesis still reads `detail.reason: cutover_v1` and cites v1 again; it does not link to the sealed file, and every anchor taken on the old chain now fails against it: `anchor_missing_seq` while the new chain is shorter than the anchored `seq`, `anchor_mismatch` once it is as long. Record in the incident the sealed file's name, sha256, last verified `seq` and `hash`, and the new chain's first `hash`. (A dedicated `operator_reseal` marker citing the sealed head is planned, not built; until then the incident record is the link.)
6. Take a new off-host anchor with `--emit-anchor`, and re-apply `chattr +a`.

## Untested caveats (carry into PK-8/PK-9)

- The production image's plugin runtime was not checked: the factory context fields (`requesterSenderId`, `sessionKey`) and async-context propagation through the host's tool execution rest on probe S0 (a source build of the same code line with a mock model) and on reading the source.
- Thread-bound (`mode: "session"`) spawns and label visibility in announce text are untested (PK-7b-2).
- `fsync` latency and lock behaviour on the production bind mount are unmeasured.
- That every M1 endpoint accepts the extra `bot_audit_id` parameter, and its effect on caching or throttle keys, is unverified (PK-8).

## Size justification

PK-7b-1 is above the repository's 500-line / 3-file proportionality gate. It is the control that INV-15 (no request without a durable audit row) and INV-6 (a tamper-evident, verifiable log) rest on, and the owner's requirement was an audit trail that is "strong and intact": fail closed on a broken or unwritable log, recover automatically from crashes and full disks, and verify independently of the plugin. The chain and writer came out at about twice the spec's estimate (the spec's S1 estimate was about 270 lines; `src/audit-chain.ts` is about 570 code lines), mostly for the lock, torn-tail repair, recovery and defensive opens. A conformance review's cut table found only the periodic re-sweep and the streaming v1 reader safe to cut, and both were cut; the advisory lock, multi-fragment repair, params size cap, the verifier's own canonical form, the call context and the registry plumbing each protect a stated invariant and stay. Spoke attribution and the confirm/approver rows were split out to PK-7b-2.
