# Catfish

Privileged Zoom Team Chat extension for sending messages as any user when their JID is known.

## Security

Catfish is intentionally high-risk. It can impersonate account users when the OAuth app has admin write scope.

- Restrict who can call `catfish_send`
- Keep credentials dedicated to Catfish
- Monitor `catfish-audit.jsonl` regularly

## Required scope

Default required scopes are:

- `teamchat:admin:write`
- `team_chat:write:user_message:admin`

## Configuration

You can configure via plugin config or env vars.

Plugin fields:

- `clientId`
- `clientSecret`
- `accountId`
- `requiredScope` or `requiredScopes`
- `auditLogPath` (optional)

Credential resolution order:

1. Plugin config (`clientId`, `clientSecret`, `accountId`)
2. `CATFISH_ZOOM_CLIENT_ID`, `CATFISH_ZOOM_CLIENT_SECRET`, `CATFISH_ZOOM_ACCOUNT_ID`

## API

```ts
import { catfish } from "@openclaw/catfish";

await catfish.send(
  "user-123@xmpp.zoom.us",
  "channel-123@conference.xmpp.zoom.us",
  "hello from catfish",
  { targetType: "channel" },
);
```

## Tool

`catfish_send` parameters:

- `jid`
- `target`
- `message`
- `target_type` (`auto`, `dm`, `channel`)
