# RingCentral → Microsoft Teams Migration Guide

> **Status**: Starter template — not yet battle-tested. Refine through testing.

## Phase 1: Data Gathering — API Calls

**Source (RingCentral) — all required:**
1. User details: `call_platform_api("ringcentral", "GET", "/extensions/{extensionId}")`
2. Phone numbers: `call_platform_api("ringcentral", "GET", "/voice-proxy/account/~/extension/{extensionId}/phone-number")`
3. Forwarding numbers: `call_platform_api("ringcentral", "GET", "/extensions/{extensionId}/forwarding-number")`
4. Call handling: `call_platform_api("ringcentral", "GET", "/voice-proxy/restapi/v2/accounts/~/extensions/{extensionId}/comm-handling/voice/state-rules/agent")`
5. Call queues: `call_platform_api("ringcentral", "GET", "/call-queues")` then `GET /call-queues/{queueId}/members`
6. Site details: `call_platform_api("ringcentral", "GET", "/sites/{siteId}")`
7. IVR menus: `call_platform_api("ringcentral", "GET", "/ivr-menus")` then `GET /ivr-menus/{menuId}` for each

**Target (Teams) — all required:**
8. Teams users: `call_platform_api("teams", "GET", "/users")`
9. Teams call queues: `call_platform_api("teams", "GET", "/call-queues")`
10. Teams auto attendants: `call_platform_api("teams", "GET", "/auto-attendants")`

**CRITICAL**: For RingCentral, NEVER use paths starting with `/restapi/v1.0/` — they return 404. Use gateway routes listed above.

## Phase 2: Summary

Include: extension, site, phone numbers, call queue memberships, call handling, IVR/AR details, timezone.

## Phase 3: Decisions

1. **Phone number**: RC number → Teams number assignment (may require porting).
2. **Call queues**: RC call queue → Teams call queue.
3. **Auto attendant**: RC IVR menu → Teams auto attendant. Note: Teams auto attendants use different configuration patterns than RC IVR menus.

## Phase 4: Execution Order

1. Create/find Teams user
2. Assign phone number
3. Configure call queues
4. Configure auto attendant (if applicable)

## Common API Paths

**RingCentral:** Same gateway routes as RingCentral→Zoom guide.

**Teams:** Use `search_endpoints("teams", "query")` to discover available paths.
