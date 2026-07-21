<!--
  Design: evolving the ScopelyBot chassis into an end-user-facing support
  service for the Scopely (PSCX VIP) app. Written 2026-07-20, immediately after
  the confirm-gate stack deploy (#70/#77/#73/#76) and the T1/T2 live validation
  program — every "exists today" claim below was exercised on prod that day.
  Companion docs: scopelybot-e2e-validation.md (evidence), scopelybot-hub-spoke-
  recommendation.md (as-built), scopelybot-spoke-partitioning-problem.md.
-->

# Scopely End-User Support Service — design

## 0. Decision frame

**Audience decision (recommended, pending PM ratification): design for external
org users** — e.g. an `org_admin` at a customer org — not just internal sales
reps. It is the harder trust bar; internal reps are already served by the admin
bot track. Everything below assumes external users.

**Prime directive: do not widen the admin bot.** vipbot_prod runs with an
admin-privileged BFF session and write verbs. End users get a NEW, narrower
surface on the same chassis. The admin bot is a master key; a master key is not
a hotel room key.

## 1. Chassis inventory — what exists and is battle-validated (2026-07-20)

| Capability                                                                                        | Where                                                                    | Proof                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------- |
| Confirm-gate (stage-only writes, CSPRNG code, TTL, single-use, channel-bound, approver allowlist) | `extensions/scopelybot/src/gated.ts`, `pending-confirm.ts`, `confirm.ts` | T2 S10/S11/S18 live PASS  |
| Bundled confirms (one prompt/one code per multi-write turn)                                       | `gated.ts` (`SCOPELYBOT_CONFIRM_BUNDLE_MS`)                              | T2 S19 live PASS          |
| Per-bot CONFIRM claim scoping (six bots coexist safely)                                           | each bot's `index.ts` session-key guard (PR #77)                         | T2 S13 claim markers      |
| Chat-operable approver grants w/ identity ledger                                                  | `approver-store.ts`, `approver-tools.ts` (PR #73)                        | T2 S17 fail-fast PASS     |
| Audit trail with boundary redaction                                                               | `audit.ts`, `redaction.ts` → `workspace/scopelybot/audit.jsonl`          | used as C4 oracle all day |
| Voice contract (plain text, answer-first, NO_REPLY discipline, "way forward" rule)                | coordinator IDENTITY.md                                                  | T1 S2b/S9 PASS            |
| Multi-bot fleet mechanics (channel binding, per-agent `tools.allow`)                              | prod `openclaw.json`                                                     | 6 gated bots in prod      |
| E2E validation program w/ oracle discipline                                                       | `docs/reference/scopelybot-e2e-validation.md`                            | 13 scenarios logged       |

Gaps that block end-user exposure: per-user identity/OBO auth (§2), the
support surface itself (§3), a runtime supervisor (§4), ticketed escalation
(§5), a knowledge plane (§6).

## 2. Tenancy — the wall is already built; we only need the door

### 2.1 Discovery: server-side org scoping exists

The Scopely backend already enforces tenancy at the ORM boundary:

- `OrgScopedQuerySet.for_user(user)` — `service/apps/core/scoping.py:55`.
  Fail-closed (unauthenticated → empty, no profile → empty), role-aware:
  `PLATFORM_ROLES` unrestricted; `org_admin` → own org's rows; `user` → own
  rows or org rows; org-less user → own rows only.
- Wrapped by `scoped_sessions(user)` and `get_owned_session()` (out-of-scope → 404) — `service/apps/scoping/views/_common.py:14,25`.
- Enforced on the user-facing read plane the support bot needs:
  `MySessionsView` (`apps/scoping/views/sessions.py:1057`, `GET /api/v1/sessions/my/`),
  session detail/context, `GET /api/v1/sessions/notifications/`.
- Roles: `apps/users/models.py:287-297` (`platform_admin`, `power_user`,
  `org_admin`, `user`, `partner_readonly`); permission classes in
  `apps/users/permissions.py` (`IsPlatformStaff`, `IsOrgAdminOrAbove`, …).

**Consequence:** the bot must NOT reimplement authorization. It must simply
call the existing user-facing endpoints _authenticated as the end user_, and
`for_user` does the rest. The entire tenancy ask on the Django side reduces to
an on-behalf-of (OBO) credential.

### 2.2 The OBO contract (the one new backend surface)

Add a **subject-bound, read-only, short-lived support token**:

```
POST /api/v1/auth/support-tokens/          (service credential required)
  body: { "subject_email": "user@org.com", "channel_ref": "<zoom channel/DM id>" }
  → 201 { "token": "<jwt>", "expires_in": 900 }
```

- **Mint auth:** a dedicated service account credential held only by the
  support-bot container (same secret plane as the existing extraction-service
  `X-Api-Key` pattern). Minting is itself audited (who was impersonated, when,
  from which channel).
- **Token shape (SimpleJWT custom token):** `sub` = subject user id,
  `act: "scopely-support-bot"` (RFC 8693-style actor claim),
  `scope: "support:read"`, TTL ≤ 15 min, **no refresh**.
- **Acceptance:** a custom DRF authentication class accepts these tokens ONLY
  for safe methods (GET/HEAD) and ONLY on an allowlisted set of user-facing
  routes (`sessions/my/`, `sessions/<pk>/`, `sessions/notifications/`, SOW
  status, own profile). Any write attempt with a support token → 403, logged.
- **Identity binding (Zoom → Scopely):** the #73 identity ledger already maps
  channel posts → `operator_id` + email. Extend: on first contact, match the
  Zoom operator email against `User.email`; ambiguity or no match → the bot
  refuses data access and offers the account-linking way forward. No
  self-asserted emails — only webhook-attested identity.

Estimated Django footprint: 1 token class + 1 mint view + 1 auth class +
route allowlist + tests. No changes to existing views — `for_user` already
guards them.

### 2.3 What the bot-side changes

`scopely-api.ts` today holds ONE admin cookie session. The support bot instead
holds a per-conversation token cache: resolve requester → mint OBO token →
call user-facing endpoints with `Authorization: Bearer` → drop at TTL. The
admin BFF login path is simply absent from the support bot's config.

## 3. The support surface — `scopely-support` sibling agent

Instantiate as a seventh gated bot (the fleet pattern is proven):

- **Binding:** per-org channels or 1:1 DMs; NEVER vipbot_prod. Channel →
  agent binding is existing `openclaw.json` mechanics.
- **Toolset (`tools.allow`):** read-only-about-your-own-stuff (my sessions,
  session status/timeline, SOW status, notifications, KB search) plus
  `scopely_create_support_ticket`. **Zero admin verbs, zero config verbs,
  zero other-user lookups.** The role-derived surface is config, not code.
- **IDENTITY:** support voice — answer-first, plain language, no internal
  jargon (no container names, no spoke names), ALWAYS a way forward
  (generalizes the S2b-validated rule), response-time honesty on slow ops.
- **Write plane:** none at launch. If writes ever come (e.g. "archive my
  draft"), they inherit the full confirm-gate unchanged — the invariant is
  audience-independent.

## 4. Runtime supervisor (Slice S) — findings and design

### 4.1 Audit of the existing `slm-supervisor` plugin (prod, enabled)

It is NOT a turn supervisor. It is an **HTTP-service scaffold for SLM-first
answering** (small model answers, supervisor reviews, training studio,
tenant-keyed decision traces) whose core services are **stubs**:
`StubSupervisorService` keyword-matches "policy"/"forbidden" and fabricates
confidence numbers (`src/supervisor.ts:15-51`); `StubPrimaryAnswerService`;
`directFallback` echoes the question. It registers gateway routes, not agent
hooks — it never touches scopelybot's turns. **Slice S is uncovered.**

Reusable from it (shapes, not wiring): `SupervisorVerdict`
(approve/edit/reject + reason codes), `EscalationPolicyEngine`
(`src/policy.ts` — confidence/grounding thresholds → escalate), the
decision-trace store/exporter.

### 4.2 Design

Wire a per-turn supervisor into **`before_agent_finalize`** (real, tested
modifying hook — `src/plugins/hook-types.ts:79`, runner `src/plugins/hooks.ts:971`):

1. **Rules check** — audience policy (no secrets, no other-org references, no
   internal jargon for support surface).
2. **Voice check** — conversation-contract conformance.
3. **Data-correctness probe** — every factual claim about app state must trace
   to a tool read in THIS turn; if the draft asserts state with no matching
   read, force a re-read (T1 S9 showed the coordinator already re-probes
   sometimes; the supervisor makes it mandatory).
4. **Bounded retry** — reject → one revision cycle, not a loop.
5. **The fuse** (Doug's requirement) — N failures in a window (per
   conversation or per tool) → stop retrying, post a plain-language handoff
   naming a human owner, open a ticket (§5), and trip a cooldown. Fold in the
   Hermes-research takeaway: per-transport circuit breaker on repeated
   network failures.

Scope first delivery to the support bot (smaller tool surface, read-only =
cheapest verification), then back-port to the admin bot.

**Out of the supervisor's reach, by construction: the confirm gate.** The
supervisor reviews _answers_; it must never be able to fabricate, relay, or
approve a CONFIRM.

## 5. Escalation & tickets — the no-dead-end guarantee

Top-tier support is defined by how it fails. Every conversation terminates in
exactly one of: **answer / ticket / named human**. Never silence.

- `scopely_create_support_ticket` — staged via the existing `stageWrite()`
  pattern? No: ticket creation is the one write end users may trigger
  UNGATED (it mutates nothing in the product; it creates work for us).
  Direct create, audited.
- Handoff packet: transcript summary + the turn's tool trace (from
  audit.jsonl) posted to an internal triage channel — the human starts with
  evidence, not archaeology.
- SLA timer on open escalations rides the existing passthrough-runner
  interval pattern; breaches ping the triage channel.
- Backend: reuse GitHub issues for v1 triage (repo-allowlisted `gh` tooling
  exists) — a dedicated ticket store only when volume justifies it.

## 6. Knowledge plane

End users ask "how do I…" — product questions, not ops questions.

- Corpus: wizard help, pricing/SOW process docs, vendor/project-type
  explanations. Curated, versioned, vectorized (aligns with the stated
  platform direction: knowledge/logs into vector stores).
- Grounding rule (enforced by the supervisor): a product-behavior answer must
  cite a KB entry or a tool read; otherwise the bot says it doesn't know and
  offers the ticket path. No improvised product answers to customers, ever.

## 7. Quality regime & metrics

- **Pre-live gate:** genie routing harness needs a prod-safe profile (known
  gap — the current profile targets the dev_vipbot binding and cannot run on
  prod; see the 2026-07-20 deploy record in scopelybot-e2e-validation.md).
- **Continuous probes:** promote the T1/T2 scenario corpus to a scheduled
  suite against a canary org, with the same C1-C8 checkpoint discipline.
- **Metrics (from audit.jsonl + gateway logs):** deflection rate (answered
  without human), time-to-first-useful-answer, escalation rate + SLA
  breaches, per-scenario probe pass rate, CSAT (lightweight in-thread ask).
- **Ops:** daily digest to the internal channel (planned Slice 4), on-call
  owner for the fuse's escalations, versioned config via the routing SSOT
  (Slice 5) so IDENTITY/allowlists stop drifting.

## 8. Rollout

| Phase                       | Content                                                                                           | Gate to advance                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| P1 (now → Aug 1, committed) | Slice S supervisor on the admin bot + Slice 2 remainder (internal self-serve)                     | supervisor live, probe suite green                                            |
| P2                          | OBO token contract in Django (§2.2) + Zoom↔Scopely identity binding                               | security review of token class; write-attempt 403 tests                       |
| P3                          | `scopely-support` pilot: ONE friendly org, read-only + tickets + KB, supervisor on, metrics wired | 2 weeks: deflection >50%, zero cross-org leaks, zero unproven-claim incidents |
| P4                          | Hardening: prompt-injection red-team (external users WILL try), rate limits, SLOs; org-by-org GA  | red-team report clean; on-call staffed                                        |

## 9. Risks & open questions

- **Channel-fit:** Zoom Team Chat only reaches customers who live in Zoom. If
  most end users live in the web app, P3's pilot may belong in an in-app chat
  surface backed by the same agent chassis (the chassis is channel-agnostic;
  the Zoom connector is one binding). Decide at P3 with real usage data.
- **Identity edge:** users whose Zoom email ≠ Scopely account email (the
  jrickert case — recreated accounts, empty names). The account-linking flow
  must handle mismatch explicitly, not fuzzily.
- **Prompt injection:** external input reaching an LLM with tool access.
  Mitigations: read-only toolset, OBO scoping (blast radius = the requester's
  own data), supervisor rules pass, red-team gate at P4.
- **PM ratification needed:** audience decision (§0), ticket destination
  (§5), pilot org (P3).
