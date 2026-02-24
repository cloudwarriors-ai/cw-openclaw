---
name: zw-studio
description: >
  Submit and manage ZoomWarriors Developer Studio change requests.
  Supports developer (full-stack) and designer (frontend-only) modes.
  Handles slot management, request submission, progress monitoring,
  screenshot review, and approve/reject workflows.
  Triggers: /studio, "submit studio request", "make a change to ZW",
  "studio request", "developer request", "designer change",
  "check studio status", "approve studio request".
metadata:
  openclaw:
    emoji: "🏗️"
---

# ZoomWarriors Developer Studio

Submit AI-driven change requests to ZoomWarriors, monitor progress, review previews and screenshots, then approve or cancel — all from chat.

## References

- `references/api-field-reference.md` — response shapes, status lifecycle, field definitions
- `references/screenshot-handling.md` — how to present screenshots across channels

## Mode Detection

Determine which mode to use based on the user's request:

| Signal                                     | Mode                         | Why                                                          |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| Backend, API, database, migrations, models | **Developer** (full-stack)   | Needs a preview slot for Docker backend containers           |
| CSS, styling, layout, UI component, design | **Designer** (frontend-only) | No slot needed, frontend preview only                        |
| Ambiguous or mixed                         | **Ask the user**             | "Does this involve backend changes, or is it frontend-only?" |

## Workflow 1: Developer Mode (Full-Stack)

### Step 1 — Check & Lock a Slot

1. `zw_studio_list_slots(available_only: true)` — find an open slot.
2. If none available, tell the user: "All preview slots are in use. Try again shortly or check who has them locked with `zw_studio_list_slots()`."
3. If available, auto-select the first one: `zw_studio_lock_slot(slot_id)`.
4. Confirm: "Locked slot {N} for you."

### Step 2 — Submit the Request

1. Confirm the request text with the user: "I'll submit: _{request_text}_. Go ahead?"
2. `zw_studio_submit_developer_request(request_text, slot_id)`.
3. Capture the `id` from the response.
4. Tell the user: "Request #{id} submitted. AI agents are working on it..."

### Step 3 — Poll for Progress

Poll `zw_studio_get_request(request_id)` every 10-15 seconds until status leaves `processing`.

Relay `task_steps` progress to the user as updates arrive:

| task_steps[].step       | User-friendly message                   |
| ----------------------- | --------------------------------------- |
| `cloning_repo`          | "Cloning repository..."                 |
| `running_agent`         | "AI agent implementing changes..."      |
| `building_preview`      | "Building Docker preview containers..." |
| `deploying_preview`     | "Deploying preview..."                  |
| `capturing_screenshots` | "Capturing screenshots..."              |
| `completed`             | "Done!"                                 |

**Stop conditions:**

- `status: "preview"` — success, show results
- `status: "failed"` — show `error_message`, offer to retry or cancel
- `status: "rejected"` — show reason

### Step 4 — Show Results

When status is `preview`, present:

1. **Preview URLs:**
   - Frontend: `preview_url`
   - Backend: `backend_preview_url`

2. **Screenshots** (see `references/screenshot-handling.md`):
   - List each screenshot with its page name and URL
   - URLs are public — no auth needed to view

3. **Files changed:**
   - Backend: `backend_files_changed` (count + list)
   - Frontend: `frontend_files_changed` (count + list)
   - Migrations: `migrations_created` (list if any)

4. **Ask for decision:** "Approve (creates PR), request changes, or cancel?"

### Step 5 — User Decision

| User says                              | Action                                                  |
| -------------------------------------- | ------------------------------------------------------- |
| "approve"                              | `zw_studio_approve_request(request_id)` — show `pr_url` |
| "cancel"                               | `zw_studio_cancel_request(request_id)`                  |
| "request changes" or describes changes | Start conversational refinement (Workflow 3)            |

### Step 6 — Cleanup

After approve or cancel:

1. `zw_studio_cleanup_request(request_id)` — tear down Docker preview containers.
2. `zw_studio_unlock_slot(slot_id)` — release the slot.
3. Confirm: "Preview cleaned up. Slot {N} unlocked."

## Workflow 2: Designer Mode (Frontend-Only)

No slot management needed.

### Step 1 — Submit

1. Confirm the request text with the user.
2. `zw_studio_submit_frontend_request(request_text)`.
3. Capture the `id`.

### Step 2 — Poll for Progress

Poll `zw_studio_get_frontend_request(request_id)` every 10-15 seconds.

Relay `task_steps` progress (same step names as developer mode).

### Step 3 — Show Results

When status is `preview`:

1. **Preview URL:** `preview_url`
2. **Screenshots:** list with page names and URLs
3. **Files changed:** `files_changed`
4. **Ask:** "Approve (creates PR) or cancel?"

### Step 4 — User Decision

- "approve" — approve via the API, show `pr_url`
- "cancel" — `zw_studio_cancel_request(request_id)`

No cleanup step needed for frontend-only requests.

## Workflow 3: Conversational Refinement

Use when the user wants to iterate on requirements before executing, or when they say "request changes" after seeing a preview.

### Step 1 — Start Session

`zw_studio_start_session(change_request_text)` or `zw_studio_start_session(change_request_id)` if refining an existing request.

### Step 2 — Relay Agent Questions

Poll `zw_studio_get_session(session_id)` to get the latest messages.

The conversational agent will ask clarifying questions. Relay these to the user naturally — don't dump raw JSON.

### Step 3 — User Responds

Take the user's answer and send it: `zw_studio_session_chat(session_id, content)`.

### Step 4 — Repeat Until Ready

Keep relaying questions and answers. Check `is_ready_to_execute` on each poll.

When `is_ready_to_execute` is true:

1. Show the `refined_request_text` to the user.
2. Ask: "The refined request is ready. Execute it?"

### Step 5 — Execute

`zw_studio_session_proceed(session_id)` — creates a new `DeveloperChangeRequest` with the refined text.

Resume the Developer Mode polling loop (Workflow 1, Step 3) with the new request ID.

## Workflow 4: Status Check

When the user asks about existing requests or studio status:

1. `zw_studio_list_requests()` — show recent requests in a summary table:
   - ID, request_text (truncated), status, created_at
2. For any active request, offer: "Want me to poll for updates on #{id}?"
3. `zw_studio_get_request_stats()` — show aggregate counts if requested.
4. `zw_studio_list_slots()` — show slot availability if asked.

## Error Handling

| Scenario                         | Action                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| No slots available               | Tell the user, show who has them locked, suggest waiting      |
| Request submission fails (400)   | Show validation errors, ask user to rephrase                  |
| Request fails during processing  | Show `error_message`, offer to retry with same text           |
| Slot lock fails (already locked) | Show who locked it, try another slot                          |
| Auth error (401)                 | Transparent — `zw2Fetch` auto-refreshes tokens                |
| Server error (500)               | "The Studio backend is having issues. Try again in a moment." |

## Polling Best Practices

- Poll every **10-15 seconds** — not faster (the backend polls internally at 1s, our interval is efficient).
- Only relay **new** task steps to the user — don't repeat completed steps.
- If a request has been processing for more than 5 minutes with no step changes, warn the user: "This is taking longer than usual. Want to keep waiting or cancel?"
- Stop polling when status reaches a terminal state: `preview`, `failed`, `rejected`, `approved`, `merged`.
