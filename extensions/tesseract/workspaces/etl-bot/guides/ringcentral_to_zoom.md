# RingCentral → Zoom Migration Guide

## Phase 1: Data Gathering — API Calls

**Source (RingCentral) — all required:**
1. User details: `call_platform_api("ringcentral", "GET", "/extensions/{extensionId}")`
2. Phone numbers: `call_platform_api("ringcentral", "GET", "/voice-proxy/account/~/extension/{extensionId}/phone-number")`
3. Forwarding numbers: `call_platform_api("ringcentral", "GET", "/extensions/{extensionId}/forwarding-number")`
4. Call handling (agent rule — includes ring duration, forwarding, voicemail): `call_platform_api("ringcentral", "GET", "/voice-proxy/restapi/v2/accounts/~/extensions/{extensionId}/comm-handling/voice/state-rules/agent")` — MUST use this exact path. Do NOT use `/restapi/v1.0/...` or `/voice-proxy/account/~/extension/{id}/answering-rule` — those are disabled.
5. Call handling (forward-all-calls rule — includes business hours schedule): `call_platform_api("ringcentral", "GET", "/voice-proxy/restapi/v2/accounts/~/extensions/{extensionId}/comm-handling/voice/state-rules/forward-all-calls")`
6. Call queues: `call_platform_api("ringcentral", "GET", "/call-queues")` then for EACH queue `GET /call-queues/{queueId}/members` — check if the user's extensionNumber appears in any queue's member list
7. Site details: `call_platform_api("ringcentral", "GET", "/sites/{siteId}")` — use the `siteId` from the user's extension record (NOT the extension's own `id`)
8. **IVR menus — TWO ROUNDS OF CALLS REQUIRED**:
   - Call A: `call_platform_api("ringcentral", "GET", "/ivr-menus")` → returns a list with menu IDs and names ONLY (no key press details!)
   - Call B (FOR EACH menu): `call_platform_api("ringcentral", "GET", "/ivr-menus/{menuId}")` using each menu's `id` from Call A → returns the FULL details: greeting prompt text, key press actions, and routing destinations
   You MUST make Call B for each menu. The list from Call A does NOT contain key press details. If you skip Call B, you will NOT have the data needed for Phase 2 and Phase 3.
   NEVER say "I will fetch details later" — fetch them NOW.

**Target (Zoom) — all required:**
9. Zoom sites: `call_platform_api("zoom", "GET", "/api/phone/sites")`
10. Zoom call queues: `call_platform_api("zoom", "GET", "/api/phone/call_queues")`
11. Zoom phone numbers: `call_platform_api("zoom", "GET", "/api/phone/numbers", params={"type": "unassigned"})`
12. Whether user already exists in Zoom: `get_platform_users("zoom", search="{email}")`

**CRITICAL**: NEVER construct paths starting with `/restapi/` — they will return "Not Found". The ONLY exception is the v2 comm-handling path which goes through `/voice-proxy/restapi/v2/...`. For everything else, use the gateway routes listed in "Common API paths" below.

## Phase 2: Summary — What to Include

Your summary MUST include ALL of these for a RingCentral user:
- Extension number
- Site name
- Phone numbers (with type: VoiceFax, FaxOnly, etc.)
- Call queue memberships
- Call handling settings from step 4: ring duration, simultaneous/sequential ring, forwarding rules, voicemail behavior
- Business hours schedule from step 5: what hours, what days, what timezone. If the forward-all-calls rule shows business hours, list them (e.g. "Mon-Fri 9am-5pm ET"). If 24/7, say "24/7".
- **Auto Receptionist / IVR** — from Phase 1 step 8 Call B data, show:
  - AR name and extension number
  - Greeting text (the actual TTS text or audio prompt name)
  - Each key press and its destination (e.g. "1→Demo God test 1 (ext 16102), 2→Voicemail, 3→Dial by Name, *→Return")
  - If you don't have key press data, you forgot to make Call B in Phase 1 step 8 — go back and fetch it NOW.
- Timezone

## Phase 3: Decisions & Execution

**MANDATORY STEP ORDER — complete each step fully before starting the next:**
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
Do NOT skip ahead. Do NOT reorder. After each step, say "Step X complete. Moving to Step Y."

**Step 1 — Create Zoom user** (do this FIRST, before anything else):

Check if the user already exists in Zoom (from Phase 1 step 12). If NOT:
1. Create the user: `create_zoom_user(email, first_name, last_name)`
2. Enable Zoom Phone: `enable_zoom_phone(email, true)`
3. Report: "✓ Created [name] in Zoom and enabled Zoom Phone. Step 1 complete. Moving to Step 2."

If the user already exists in Zoom, say "✓ User already exists in Zoom. Step 1 complete. Moving to Step 2."
Do NOT ask permission — just create the user. This is a prerequisite for all other steps.

**Step 2 — Site AND Auto Receptionist** (these are ONE combined step):

First, ask about the site. If the source site doesn't exist in Zoom, ask: create it or assign to existing?

When the user says to create the site:
1. Create it with `create_zoom_site(...)`.
2. **IMMEDIATELY** (same response, no waiting) handle the auto receptionist:
   a. List all Zoom ARs: `call_platform_api("zoom", "GET", "/api/phone/auto_receptionists")` — find the one whose name contains the new site name (e.g., "Demo Site Main"). This was auto-created by Zoom.
   b. You already gathered the RC IVR menus in Phase 1 step 8. Use that data now.
   c. Tell the user what Zoom auto-created AND what RC had: "Zoom auto-created an AR called '[name]'. In RingCentral, the site had '[AR name]' with greeting '[actual greeting text]' and key presses: [1→actual destination, 2→actual destination, etc.]. Should I configure the Zoom AR to match?"
   d. If RC had NO IVR menus: say "No IVR was configured in RC. The default Zoom AR is fine — moving on to phone numbers."
3. If user says yes to configuring:
   - PATCH name and timezone: `call_platform_api("zoom", "PATCH", "/api/phone/auto_receptionists/{arId}", body={"name": "AR Demo Test", "timezone": "America/New_York"})`
   - Configure IVR key presses using the **dedicated tool**: `configure_zoom_ar_ivr(ar_id, key_actions, no_input_action)`. This tool handles the correct API path and translates actions to Zoom codes internally. Example:
     ```
     configure_zoom_ar_ivr(
       ar_id="the_ar_id",
       key_actions=[
         {"key": "1", "action": "connect_to_extension", "target_email": "user@example.com"},
         {"key": "2", "action": "voicemail", "target_email": "user@example.com"},
         {"key": "3", "action": "dial_by_name"},
         {"key": "*", "action": "return_to_previous"},
         {"key": "#", "action": "repeat_menu"}
       ],
       no_input_action="disconnect"
     )
     ```
     Valid actions: connect_to_extension (needs target_email), voicemail (optional target_email), dial_by_name, repeat_menu, return_to_previous, disconnect.
     Do NOT use call_platform_api for IVR configuration — ALWAYS use configure_zoom_ar_ivr.
   - Report: "✓ Configured AR with IVR key presses"

DO NOT skip the AR part. DO NOT move to phone numbers until AR is handled. The AR is part of this step, not a separate step.

**Step 3 — Phone number**: Show what they have in RC and what's available in Zoom. Ask to assign or skip.

**Step 4 — Call queues**: If creating a new queue, use `create_zoom_call_queue(name, site_id?)` — it auto-generates the extension number. Then use `add_user_to_zoom_queue(queue_id, email)` to add the user. The user was already created in Step 1, so this will work.

Do NOT say "migration complete" after Step 4. There is still Step 5.

**Step 5 — Business hours and call handling**: This step is MANDATORY — do NOT skip it. The migration is NOT complete until this step is done.

You ALREADY gathered the call handling and business hours data in Phase 1 steps 4-5. Present that data now — do NOT make new API calls to fetch it again. Tell the user what RC had:
- Business hours schedule (days, hours, timezone)
- Ring duration and ring mode (simultaneous vs sequential)
- Forwarding rules (what happens when no answer)
- Voicemail behavior

Then configure in Zoom:
1. Get current Zoom call handling: `call_platform_api("zoom", "GET", "/api/phone/users/{email}/call_handling/settings")`
2. PATCH call handling to match RC settings: `call_platform_api("zoom", "PATCH", "/api/phone/users/{email}/call_handling/settings", body={...})`
   - `ring_mode`: "simultaneous" or "sequential"
   - `max_wait_time`: ring duration in seconds (e.g. 30)
3. For business hours: `call_platform_api("zoom", "GET", "/api/phone/users/{email}/settings")` to see current, then PATCH to update if needed.

Report what was configured and what the user should verify manually in the Zoom admin portal (e.g., specific forwarding numbers, voicemail greetings).

IMPORTANT: To retrieve RingCentral data at ANY point during migration, use `call_platform_api("ringcentral", ...)` with the API paths listed in "Common API Paths" below. NEVER use `query_etl` — that queries the internal ETL database, not live platform data.

## Creating Sites

When the source site doesn't exist on Zoom:
1. Get source site details: `call_platform_api("ringcentral", "GET", "/sites/{siteId}")` — use the `siteId` from the extensions list. The response has `businessAddress` with `street`, `city`, `state`, `zip`, `country`
2. Map the address: RC `street` → Zoom `address_line1`, RC `state` → Zoom `state_code` (2-letter), RC `country` ("United States") → Zoom `country_code` ("US")
3. Call `create_zoom_site(name, address_line1, city, state_code, zip)`
4. IMPORTANT: Zoom auto-creates a main auto receptionist. After creating the site, list ARs to find it, then ask if user wants to configure it to match source.

## Configuring Auto Receptionists

When configuring a Zoom AR to match the RingCentral source:
1. Get the auto-created AR's ID: `call_platform_api("zoom", "GET", "/api/phone/auto_receptionists")` — filter by site name
2. PATCH basic settings (name, timezone): `call_platform_api("zoom", "PATCH", "/api/phone/auto_receptionists/{arId}", body={"name": "AR Demo Test", "timezone": "America/New_York"})`
3. **Configure IVR key presses** — ALWAYS use the dedicated tool:
   ```
   configure_zoom_ar_ivr(
     ar_id="the_ar_id",
     key_actions=[
       {"key": "1", "action": "connect_to_extension", "target_email": "user@example.com"},
       {"key": "2", "action": "voicemail", "target_email": "user@example.com"},
       {"key": "3", "action": "dial_by_name"},
       {"key": "*", "action": "return_to_previous"},
       {"key": "#", "action": "repeat_menu"}
     ],
     no_input_action="disconnect"
   )
   ```
   Do NOT use `call_platform_api` for IVR key presses — the `configure_zoom_ar_ivr` tool handles the correct API path and action codes internally.
   Valid actions: connect_to_extension (requires target_email), voicemail (optional target_email), dial_by_name, repeat_menu, return_to_previous, disconnect.
4. DO NOT create a new AR — always update the auto-created main AR.

## Common API Paths

**RingCentral — gateway routes (use these EXACT paths):**
- Extension details: `GET /extensions/{extensionId}`
- Extension list: `GET /extensions?page=1&perPage=100`
- Forwarding numbers: `GET /extensions/{extensionId}/forwarding-number`
- Caller ID: `GET /extensions/{extensionId}/caller-id`
- Sites list: `GET /sites`
- Site details: `GET /sites/{siteId}`
- Call queues: `GET /call-queues`
- Call queue details: `GET /call-queues/{queueId}`
- Call queue members: `GET /call-queues/{queueId}/members`
- IVR menus: `GET /ivr-menus`
- IVR menu details: `GET /ivr-menus/{menuId}`
- Phone numbers: `GET /phone-numbers`

**RingCentral — voice-proxy paths (ONLY for endpoints without explicit gateway routes):**
- Per-extension phone numbers: `GET /voice-proxy/account/~/extension/{extensionId}/phone-number`
- Call handling (agent): `GET /voice-proxy/restapi/v2/accounts/~/extensions/{extensionId}/comm-handling/voice/state-rules/agent`
- Call handling (forward-all): `GET /voice-proxy/restapi/v2/accounts/~/extensions/{extensionId}/comm-handling/voice/state-rules/forward-all-calls`
- Voicemail: `GET /voice-proxy/account/~/extension/{extensionId}/voicemail`
NEVER use paths starting with `/restapi/v1.0/` — they return 404. NEVER use `/voice-proxy/account/~/extension/{id}/answering-rule` — disabled (CMN-468).

**Zoom:**
- User settings: `GET /api/phone/users/{userId}/settings`
- User settings update: `PATCH /api/phone/users/{userId}/settings`
- Call handling: `GET /api/phone/users/{userId}/call_handling/settings`
- Call handling update: `PATCH /api/phone/users/{userId}/call_handling/settings`
- Sites: `GET /api/phone/sites`
- Call queues: `GET /api/phone/call_queues`
- Auto receptionists: `GET /api/phone/auto_receptionists`
- Auto receptionist update: `PATCH /api/phone/auto_receptionists/{arId}` (name, timezone, audio_prompt_language)
- AR IVR config (read): `GET /phone/auto_receptionists/{arId}/ivr` (via proxy — no /api prefix)
- AR IVR config (update): `PATCH /phone/auto_receptionists/{arId}/ivr` (via proxy — no /api prefix)
- Phone numbers: `GET /api/phone/numbers` — params: `type` (assigned/unassigned/all), `number_type` (toll/tollfree), `site_id`
