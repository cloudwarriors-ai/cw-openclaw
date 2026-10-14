# ScopelyBot paired changeover: production read-only

This prepares the existing bot/channel for VIP/ZW; it does not deploy or authorize production writes. Native writes remain local-only. A future thin Claude MCP plugin adds no backend permission or audit authority.

## Check the package offline

From the repository root with existing dependencies installed:

```sh
node --import tsx extensions/scopelybot/scripts/preflight-readonly.ts \
  extensions/scopelybot/docs/backend.prod-readonly.example.json \
  extensions/scopelybot/docs/changeover-manifest.example.json
```

The helper opens only the two explicit inputs: regular files, at most 64 KiB each; final-component symlinks are refused. It never reads the service token, implicit workspace profile or environment credentials, writes an audit row, or invokes services. Manifest paths are declarations; verify actual host mount resolution, symlinks and ownership separately.

Exit 0 means **template valid**, not release ready. Invalid input exits 1 with bounded diagnostic codes. `--require-ready` returns 2 for a valid package: `releaseReady` is always false because the helper cannot independently verify live evidence. Completed labels never authorize a release. There is no repair option.

## Fill the paired manifest

Copy the example into the release evidence bundle. Replace null commit fields with full lowercase 40-character Git SHAs for both applications and the known-good rollback pair. Images require immutable `name@sha256:<64 hex>` references. Evidence labels are relative report paths, not URLs, secret references or values. Their syntax is validated; their reports are never opened or authenticated. Keep incomplete fields null; the example invents no release SHA.

The existing compose mount is `./.data/openclaw:/root/.openclaw`; default workspace is `/root/.openclaw/workspace`. An existing `OPENCLAW_WORKSPACE` override must resolve beneath that mount and reach the deployed process. No new variable is required. Profile/token names remain `scopelybot-backend.json` and `scopelybot-ops-token`; `SCOPELYBOT_ZOOM_CHANNEL` retains the current channel. Use existing secret provisioning at the release window; never place credentials in the manifest, examples, arguments or logs.

Production uses `https://api.vip.pscx.ai`, service-token authentication, read-only mode, digest disabled and 20 requests/minute. Legacy SCOPELY_BASE_URL is not a fallback. Invalid/missing profiles fail closed. Valid credentials, operator principals, active Zoom links, org membership and grants require separate verification; channel membership alone is not backend authorization.

## Release gates and order

1. Review paired PRs against **development**, including all migrated bot history. Reconcile auth PR 689 in `authentication/journeys.py`, preserving password-reset and operator-identity behavior. Rerun combined auth and integrated Zoom/confirmation/tool-context tests against development.
2. The paired backend change adds a draft-PR deploy guard, tested in `scripts/tests/test_preview_draft_gate.py`. After review of that guard, publish/update **draft only**. Do not close, convert to ready or add `auto-merge`: teardown on close still depends on the unresolved effective `PR_PREVIEW_DEPLOY_ENABLED` value. A ready PR can deploy on synchronize. `[skip e2e]` is no deployment guard. Historical skipped runs are not current gate evidence. Bot PR checks have no checked-in production deploy path; external GitHub review automation is separately configured.
3. Resolve the main gate explicitly: production deploy runs on main push/manual dispatch and stops only for literal `DEPLOY_ENABLED=false`. Effective organization value was unavailable, and the production environment had no protection rules at research time. History PR 683 requires its owners' agreement; do not silently accept its `-s ours` reconciliation. Resolve old cutover PRs 665/668 with their owner. PR 684 supplies the legacy frontend VITE_ADMIN_PANEL_URL build argument.
4. Build the integrated pair on the supported Linux builder; record immutable image digests, source correspondence and tests. Previous UAT images do not prove a new build. Review authentication0024, opsplane0001/0002/0003 and pricing0011 migrations, backup/restore evidence and deploy ordering. The existing main workflow starts services before migrations, tolerates backup failure and retries deployment; do not assume it satisfies this gate.
5. At the separately authorized window, deploy the reviewed backend with production write guards intact, then activate paired bot image/config in the existing workspace. Preserve channel, bindings, plugin allowlist and other bots. Verify persistent writable audit storage and backend audit joins. No new public MCP listener is required.
6. Run consolidated connected UAT: trusted identity, reads/pagination, permission refusals, production write denial and channel delivery. Record human/model outcomes separately from mocked transport/local tests. Check all 51 used reads and 18 used writes in the parity inventory; local writes do not establish production policy approval or complete parity.

## Local workflow boundaries

VIP native RateCards are Rudy's pricing authority. The bot identifies VIP scope
and never writes the older ZW BasePricing table. Verify calculated totals through
the native VIP quote path; a list of rates alone does not prove a quote outcome.

Global account unlock/activation requires a platform administrator and binds its
approval to the unique active platform organization. Synthetic target-user and
all tenant-organization allowlists remain mandatory. A platform Zoom service
credential can use these actions only with a valid mapped administrator and
human confirmation. Production still rejects them.

Session archive binds approval to the session's actual tenant. The existing
fixed platform Zoom credential cannot confirm tenant archive: use the authorized
Claude person-token path locally. Tenant credential routing requires separate
review; do not weaken the principal-organization check or claim full Zoom parity.

Account lock contention refuses explicitly without an automatic retry. A failed
confirmation consumes its claim; after contention clears, prepare a new preview
and obtain fresh human approval. This is the degraded path, not a successful
write or a promise that all database operations are nonblocking.

## Rollback and incomplete readiness

Disable access first with existing profile `mode: off`; preserve audits. Restore the manifest's known-good paired images and profile/runtime config, retaining channel identity and durable storage. Never automatically reverse migrations or restore databases: recovery needs a separately reviewed compatibility/backup plan. The default backend `/tmp/zw-ops/kill-all` file is ephemeral; existing persisted OPS_KILL_ALL is available across restarts.

A valid offline package may still lack publication gates, valid tokens, linked users, ownership, builds, human UAT or release approval. Keep each gap explicit. Production remains read-only until a separate reviewed code and policy change authorizes a wider boundary.
