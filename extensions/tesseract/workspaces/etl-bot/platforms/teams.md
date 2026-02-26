# Microsoft Teams Platform Reference

## Authentication
- **Type**: Certificate-based (certificate)
- **Required credentials**: app_id (client ID), tenant_id, certificate file (.pfx), certificate password
- **Where to get them**: Azure Portal > App Registrations > Certificates & Secrets

## Key API Paths (via gateway)
- Teams gateway uses PowerShell SDK internally
- `GET /users` - List Teams users
- `GET /call-queues` - List call queues
- `GET /auto-attendants` - List auto attendants
- `GET /phone-numbers` - List phone numbers

## Platform Quirks
- Teams has NO "sites" concept (unlike Zoom and RingCentral).
- Auto attendants use different IVR action types than other platforms.
- Certificate auth requires a .pfx file -- cannot be set up via simple text fields.
- PowerShell SDK handles all API calls internally in the gateway.

## Credential Fields
- `client_id` - Azure App (Client) ID
- `account_id` - Tenant ID
- Certificate file and password handled separately (browser automation or manual upload)
