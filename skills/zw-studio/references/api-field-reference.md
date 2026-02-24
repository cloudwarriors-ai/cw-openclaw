# ZW Studio API Field Reference

## Developer Change Request

### Status Lifecycle

```
pending → processing → preview → approved → merged
                ↓                     ↓
              failed              rejected
```

Terminal states: `preview`, `failed`, `rejected`, `approved`, `merged`.

### Response Fields

| Field                    | Type     | Description                             |
| ------------------------ | -------- | --------------------------------------- |
| `id`                     | number   | Unique request ID                       |
| `user`                   | number   | User ID                                 |
| `mode`                   | string   | `"fullstack"` or other modes            |
| `request_text`           | string   | The natural-language change description |
| `status`                 | string   | Current status (see lifecycle above)    |
| `session`                | number?  | Associated session ID                   |
| `agents_used`            | string[] | Agent names that worked on this request |
| `backend_files_changed`  | string[] | Backend file paths modified             |
| `frontend_files_changed` | string[] | Frontend file paths modified            |
| `migrations_created`     | string[] | Database migration files created        |
| `database_backup_path`   | string   | Path to DB backup (before changes)      |
| `branch_name`            | string   | Git branch name                         |
| `commit_sha_backend`     | string   | Backend commit SHA                      |
| `commit_sha_frontend`    | string   | Frontend commit SHA                     |
| `preview_url`            | string   | Frontend preview URL                    |
| `backend_preview_url`    | string   | Backend preview URL                     |
| `pr_url`                 | string   | GitHub PR URL (after approval)          |
| `deployment_id`          | string   | Docker deployment identifier            |
| `preview_slot_number`    | string   | Preview slot number used                |
| `started_at`             | datetime | When processing started                 |
| `completed_at`           | datetime | When processing finished                |
| `error_message`          | string   | Error details if failed                 |
| `task_steps`             | array    | Ordered progress steps (see below)      |
| `screenshots`            | array    | Screenshot objects (see below)          |
| `sow_screenshots`        | array    | SOW document screenshots                |
| `created_at`             | datetime | When the request was created            |
| `updated_at`             | datetime | Last update timestamp                   |

### Task Steps

Each entry in `task_steps`:

| Field          | Type     | Description                                                                                                               |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `step`         | string   | Step identifier (e.g., `cloning_repo`, `running_agent`, `building_preview`, `deploying_preview`, `capturing_screenshots`) |
| `status`       | string   | `"pending"`, `"running"`, `"completed"`, `"failed"`                                                                       |
| `message`      | string   | Human-readable status message                                                                                             |
| `started_at`   | datetime | When the step started                                                                                                     |
| `completed_at` | datetime | When the step finished                                                                                                    |
| `duration_ms`  | number   | Duration in milliseconds                                                                                                  |

### Screenshots

Each entry in `screenshots`:

| Field          | Type   | Description                                       |
| -------------- | ------ | ------------------------------------------------- |
| `page`         | string | Page path (e.g., `/dashboard`)                    |
| `filename`     | string | Image filename                                    |
| `url`          | string | Relative URL to fetch the image (public, no auth) |
| `content_type` | string | `"image/png"`                                     |

## Preview Slot

| Field            | Type      | Description                  |
| ---------------- | --------- | ---------------------------- |
| `id`             | number    | Slot database ID             |
| `slot_number`    | number    | Slot number (1, 2, 3)        |
| `preview_url`    | string    | Preview URL for this slot    |
| `locked_by`      | number?   | User ID who locked it        |
| `locked_by_name` | string?   | Display name of locker       |
| `locked_at`      | datetime? | When it was locked           |
| `current_branch` | string    | Branch deployed on this slot |
| `is_locked`      | boolean   | Whether the slot is locked   |

## Frontend Change Request

Same status lifecycle as developer requests.

| Field           | Type     | Description                    |
| --------------- | -------- | ------------------------------ |
| `id`            | number   | Unique request ID              |
| `user_email`    | string   | Submitter's email              |
| `user_name`     | string   | Submitter's display name       |
| `request_text`  | string   | Change description             |
| `branch_name`   | string   | Git branch name                |
| `preview_url`   | string   | Frontend preview URL           |
| `pr_url`        | string   | GitHub PR URL (after approval) |
| `status`        | string   | Current status                 |
| `files_changed` | string[] | Modified file paths            |
| `error_message` | string   | Error if failed                |
| `task_steps`    | array    | Progress steps (same format)   |
| `screenshots`   | array    | Screenshots (same format)      |
| `created_at`    | datetime | Created timestamp              |
| `updated_at`    | datetime | Updated timestamp              |

## Studio Session (Conversational Refinement)

| Field                   | Type     | Description                             |
| ----------------------- | -------- | --------------------------------------- |
| `id`                    | number   | Session ID                              |
| `user`                  | number   | User ID                                 |
| `slot`                  | number?  | Associated slot ID                      |
| `slot_number`           | number?  | Slot number                             |
| `title`                 | string   | Session title                           |
| `status`                | string   | `"active"`, `"completed"`, `"archived"` |
| `mode`                  | string   | `"quick"` or `"conversational"`         |
| `is_ready_to_execute`   | boolean  | Whether the refined request is ready    |
| `refined_request_text`  | string   | The refined change description          |
| `messages`              | array    | Session messages (see below)            |
| `latest_change_request` | object?  | Most recent linked change request       |
| `created_at`            | datetime | Created timestamp                       |
| `updated_at`            | datetime | Updated timestamp                       |

### Session Messages

| Field            | Type     | Description                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------------- |
| `id`             | number   | Message ID                                                                       |
| `role`           | string   | `"user"`, `"assistant"`, `"system"`                                              |
| `content`        | string   | Message text                                                                     |
| `message_type`   | string   | `"chat"`, `"status"`, `"agent_question"`, `"agent_summary"`, `"execution_ready"` |
| `change_request` | number?  | Linked change request ID                                                         |
| `created_at`     | datetime | Timestamp                                                                        |
