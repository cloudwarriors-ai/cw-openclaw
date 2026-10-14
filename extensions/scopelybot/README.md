# ScopelyBot local account workflows

`scopely_reset_user_password` now prepares `identity.users.request_reset` through the native VIP/ZW operator API. Supply native `user_id` and a configured `surface_key`; optional email must match the current account. It is available only with a local read-write backend and mapped, authorized human sender. Production and dev profiles remain refused.

Discover the native user first. The exact confirmation preview shows its native ID and `[REDACTED_EMAIL]`, explicitly indicating that the address is hidden. The backend binds and rechecks the complete address, membership, profile and current credential state. The existing exact-preview redaction guard stays unchanged. The human's existing Zoom CONFIRM or Claude ops-confirm approval queues one local reset request; it does not send inbox mail or change the password.

The backend's explicit `dispatch_local_reset` command accepts the native branded message into an ephemeral synthetic sink. It never opens SMTP or exposes the link in tool/command output. A local test can redeem the in-memory link through the native authentication service, which changes the password and clears eligible login lockouts. Prior reset links are superseded using native lifetime rules.

An uncertain dispatch is held after one durable attempt and cannot automatically retry. A changed recipient, brand, account, service identity or credential refuses delivery. This is local workflow validation, not proof of production email delivery; GitHub issue filing remains a separate workflow.

### Local server approver roster

The local `scopely_list_approvers`, `scopely_grant_approver`, and
`scopely_revoke_approver` tools use the VIP/ZW server roster. Grant/revoke select
an existing native account by email and preserve the usual human `CONFIRM` code.
The app requires a unique canonical Zoom link and existing native platform-admin
permission. Roster membership grants confirmation eligibility only; it never grants
application roles. A native admin may request a change without roster membership;
only the actual confirmer needs the live roster grant as well as native authority.

Before consuming a code, the bot fetches the current sender's eligibility. Missing,
malformed or unavailable authority refuses without consuming it; the server checks
again through the business transaction. There is no positive cache or fallback to
`writeApproverIds`, the old approver JSON file, or observed channel display names.
The old configuration field is accepted but ignored for authorization. Every old
service pending action also needs an explicitly bootstrapped server scope.

Host operators explicitly bootstrap synthetic `.invalid` seeds using the backend
`ops_local_roster` command. Chat cannot grant, repin or revoke seeded entries,
including an operator-revoked seed. Operator bootstrap/maintenance is audited;
disabling preserves roster/audit history, and populated reverse migration refuses.
There is no automatic old-roster migration or re-enable path.

This packet is local-only: production and Noob remain read only. Claude person
tokens cannot administer the Zoom-scoped roster. A future connected rollout needs
reviewed provisioning and human UAT; these local tests do not prove live Zoom or
Claude delivery. Existing outcome-unknown responses still require reconciliation
and never trigger an automatic retry.

### Local standard invitation

`scopely_create_invite` prepares `identity.invites.create`. Supply the native
`organization`, actual `inviter_user_id`, `surface_key`, first and last names,
synthetic email, and the explicit native role `standard`. Old `user`/`org_admin`
roles, existing accounts/invitations, arbitrary organization provisioning and
resend are not translated. The backend verifies all supplied identity and target
fields; the model cannot choose an inviter on another person's behalf.

The exact human preview shows native inviter/tenant IDs, names, role, brand and
seven-day lifetime, with an explicit hidden-recipient marker. The full email is
bound internally. Existing server-roster authorization and Zoom confirmation
queue one native invitation; the explicit backend `dispatch_local_invite`
command accepts one invitee message into memory only. No SMTP, administrator
copy, inbox delivery or automatic retry occurs. Uncertain outcomes require
reconciliation of the existing pending action.

Native redemption creates only the pinned standard tenant membership. Local
account maintenance then requires an explicitly allowlisted target ID and
operator platform authority; it does not grant platform membership to the
invitee. This plugin mapping is tested with mocked Zoom/HTTP boundaries and real
local audit logging; native issuance/redeem is tested separately on PostgreSQL.
Production and dev profiles refuse the invitation tool. No live channel or
production invitation delivery is claimed.
