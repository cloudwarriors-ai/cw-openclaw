# GoTo Platform Reference

## Authentication
- **Type**: OAuth2
- **Required credentials**: client_id, client_secret, account_key, email, password
- **Where to get them**: GoTo Developer Portal > OAuth Client

## Key API Paths (via gateway)
- `GET /users` - List users
- `GET /lines` - List phone lines
- `GET /dial-plans` - List dial plans

## Credential Fields
- `client_id` - GoTo OAuth Client ID
- `client_secret` - GoTo OAuth Client Secret
- `account_id` - Account Key
- Additional: email and password for initial OAuth flow
