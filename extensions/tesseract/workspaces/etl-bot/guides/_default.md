# Migration Guide (Generic)

No platform-specific migration guide is available for this source→target combination yet. Use the general workflow below and rely on `search_endpoints` to discover API paths.

## Phase 1: Data Gathering

Use `search_endpoints(source_platform, "users")`, `search_endpoints(source_platform, "sites")`, etc. to discover available endpoints, then call them with `call_platform_api`.

Gather from source:
- User/extension details
- Phone numbers
- Call handling / forwarding rules
- Call queue memberships
- Site details
- IVR menus / auto receptionists (if applicable)

Gather from target:
- Existing sites
- Existing call queues
- Available phone numbers
- Whether user already exists

## Phase 2: Summary

Present everything you found in a clean summary. Include all categories even if empty.

## Phase 3: Decisions

Walk through one decision at a time:
1. Site assignment (create new or use existing)
2. Auto receptionist configuration (if site was created)
3. Phone number assignment
4. Call queue membership

## Phase 4: Execution

Create the user on the target platform first, then configure site, phone number, and call queues.
