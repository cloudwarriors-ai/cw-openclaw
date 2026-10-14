# ScopelyBot local reset workflow

`scopely_reset_user_password` now prepares `identity.users.request_reset` through the native VIP/ZW operator API. Supply native `user_id` and a configured `surface_key`; optional email must match the current account. It is available only with a local read-write backend and mapped, authorized human sender. Production and dev profiles remain refused.

Discover the native user first. The exact confirmation preview shows its native ID and `[REDACTED_EMAIL]`, explicitly indicating that the address is hidden. The backend binds and rechecks the complete address, membership, profile and current credential state. The existing exact-preview redaction guard stays unchanged. The human's existing Zoom CONFIRM or Claude ops-confirm approval queues one local reset request; it does not send inbox mail or change the password.

The backend's explicit `dispatch_local_reset` command accepts the native branded message into an ephemeral synthetic sink. It never opens SMTP or exposes the link in tool/command output. A local test can redeem the in-memory link through the native authentication service, which changes the password and clears eligible login lockouts. Prior reset links are superseded using native lifetime rules.

An uncertain dispatch is held after one durable attempt and cannot automatically retry. A changed recipient, brand, account, service identity or credential refuses delivery. This is local workflow validation, not proof of production email delivery; invitations and GitHub issue filing remain separate workflows.
