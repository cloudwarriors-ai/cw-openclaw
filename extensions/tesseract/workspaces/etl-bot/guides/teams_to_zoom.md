# Microsoft Teams → Zoom Migration Guide

> **Status**: Starter template — not yet battle-tested. Refine through testing.

## Phase 1: Data Gathering — API Calls

**Source (Teams) — all required:**
1. User details: `call_platform_api("teams", "GET", "/users")` — search for the user by name or email
2. User policies: Check for Teams-specific policies (calling, voicemail, etc.)
3. Call queues: `call_platform_api("teams", "GET", "/call-queues")` — check if user is a member/agent
4. Auto attendants: `call_platform_api("teams", "GET", "/auto-attendants")` — list auto attendants and their configurations
5. Phone numbers: Check user's assigned phone number (LineUri field)

**Target (Zoom) — all required:**
6. Zoom sites: `call_platform_api("zoom", "GET", "/api/phone/sites")`
7. Zoom call queues: `call_platform_api("zoom", "GET", "/api/phone/call_queues")`
8. Zoom phone numbers: `call_platform_api("zoom", "GET", "/api/phone/numbers", params={"type": "unassigned"})`
9. Whether user already exists in Zoom: `get_platform_users("zoom", search="{email}")`

## Phase 2: Summary

Include: display name, UPN/email, assigned number, calling policy, voicemail policy, call queue memberships, auto attendant associations, timezone.

## Phase 3: Decisions

1. **Site**: Teams doesn't have "sites" in the same way. Ask user which Zoom site to assign to.
2. **Auto attendant → Auto receptionist**: Teams auto attendants map to Zoom auto receptionists. Note: Teams uses different IVR action types than Zoom.
3. **Phone number**: Teams LineUri → Zoom phone number assignment.
4. **Call queues**: Teams call queue → Zoom call queue.

## Phase 4: Execution Order

1. Create Zoom user: `create_zoom_user(email, first_name, last_name)` then `enable_zoom_phone(email, true)`
2. Assign to site
3. Configure auto receptionist (if applicable)
4. Assign phone number
5. Create/add to call queue: `create_zoom_call_queue(name, site_id?)` then `add_user_to_zoom_queue(queue_id, email)`

## Common API Paths

**Teams:**
- Use `search_endpoints("teams", "query")` to discover available paths — Teams gateway uses PowerShell-backed endpoints.

**Zoom:**
- Same as RingCentral→Zoom guide (sites, call queues, ARs, phone numbers all use the same Zoom endpoints).
