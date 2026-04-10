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
