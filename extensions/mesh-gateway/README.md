# Mesh Gateway

Tokenless Tailscale-authenticated mesh RPC for OpenClaw gateway sessions.

This extension registers:

- `mesh.health`
- `mesh.list_capabilities`
- `mesh.send_task`
- `mesh.reply`

Enable it through the plugin config, then expose the OpenClaw gateway through Tailscale Serve. The gateway should still bind locally; Tailscale handles network reachability and identity headers.

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "mesh-gateway": {
        "enabled": true,
        "config": {
          "enabled": true,
          "displayName": "Chad Agent",
          "allowedUsers": ["chad.simon@cloudwarriors.ai", "daniel.suarez@cloudwarriors.ai"]
        }
      }
    }
  }
}
```

Authorization is explicit allowlist only:

- The WebSocket client must be authenticated by Tailscale Serve.
- The resolved Tailscale login must be in `allowedUsers`.
- If `allowedAgents` is set, inbound `from_agent` must also match that list.

`mesh.send_task` is async-first. It returns `accepted`, then emits `running` and terminal `completed`, `failed`, or `rejected` callbacks as `mesh.task` events on the same gateway connection.

## Task completion memory (for manager-side `task_status`)

After each mesh task reaches a terminal state, the extension POSTs a `task-completed:<task_id>` memory to the local omni-mem HTTP API. The memory body includes a `<task-meta>JSON</task-meta>` block with `{ kind: "task_completion_record", task_id, status, completed_by, ... }` so that the manager-side [`task_status` MCP tool](https://github.com/Chaddacus/omni-mem) can close the loop by correlating dispatch records with completion records by `task_id`.

| Config key                    | Default                 | Purpose                                                     |
| ----------------------------- | ----------------------- | ----------------------------------------------------------- |
| `completionMemoryEnabled`     | `true`                  | Set to `false` to skip the POST entirely (legacy behavior). |
| `localOmniMemUrl`             | `http://localhost:8765` | Base URL of the local omni-mem HTTP server.                 |
| `completionMemoryWorkspaceId` | `"default"`             | `workspaceId` field on the saved memory.                    |

The POST is best-effort — failures are logged via the plugin logger and do not change the `mesh.task` event stream.
