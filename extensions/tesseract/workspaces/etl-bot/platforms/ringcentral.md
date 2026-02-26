# RingCentral Platform Reference

## Authentication
- **Type**: JWT (jwt)
- **Required credentials**: client_id, client_secret, account_id (JWT token)
- **Where to get them**: RingCentral Developer Portal > App > Credentials

## Key API Paths (via gateway)
- `GET /extensions` - List extensions (users, queues, etc.)
- `GET /restapi/v1.0/account/~/extension/{id}` - Extension details
- `GET /sites` - List sites
- `GET /call-queues` - List call queues
- `GET /call-queues/{id}/members` - Queue members
- `GET /ivr-menus` - List IVR menus
- `GET /ivr-menus/{id}` - IVR details with key presses

## Platform Quirks
- NEVER use `/restapi/v1.0/` answering-rule endpoints (disabled, CMN-468).
- Use v2 comm-handling instead: `GET /restapi/v2/accounts/~/extensions/{id}/comm-handling/voice/state-rules/agent`
- Use gateway routes, not direct `/restapi/` paths (they return 404).
- IVR menus need TWO rounds: list first to get IDs, then fetch each for full details.

## Credential Fields (PlatformConnection)
- `client_id` - App client ID
- `client_secret` - App client secret
- `account_id` - JWT token string (long, ~2000 chars)
