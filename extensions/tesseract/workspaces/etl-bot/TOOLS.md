# TOOLS.md - Tesseract Platform Notes

## Architecture

Tesseract is an AI-powered ETL platform for migrating phone system configs between cloud platforms.

```
OpenClaw (brain) ──→ Tool Proxy ──→ Django Backend (hands) ──→ Platform Gateways ──→ APIs
```

The backend handles all platform authentication, credential management, and API execution. Tools registered here are thin wrappers that proxy to the backend.

## Supported Platforms

| Platform | Gateway Port | Auth Type | Required Credentials |
|----------|-------------|-----------|---------------------|
| Zoom | 8093 | Server-to-Server OAuth | client_id, client_secret, account_id |
| RingCentral | 8078 | JWT | client_id, client_secret, account_id (JWT token) |
| Teams | 8077 | Certificate | app_id, tenant_id, certificate file + password |
| GoTo | 8079 | OAuth2 | client_id, client_secret, account_key, email, password |
| Dialpad | 8094 | API Key | api_key |

**Detailed platform reference docs** are in `platforms/` subdirectory:
- `platforms/zoom.md` — API paths, quirks, provisioning order
- `platforms/ringcentral.md` — API paths, v2 comm-handling rules
- `platforms/teams.md` — PowerShell SDK, no-sites quirk
- `platforms/goto.md` — OAuth flow, credential fields
- `platforms/dialpad.md` — API key auth, endpoints

## Migration Guides

Step-by-step migration workflows are in `guides/` subdirectory:
- `guides/teams_to_zoom.md` — Teams to Zoom migration
- `guides/ringcentral_to_zoom.md` — RingCentral to Zoom migration
- `guides/ringcentral_to_teams.md` — RingCentral to Teams migration
- `guides/_default.md` — Fallback for unmapped platform pairs

Load the relevant guide FIRST when starting any migration.

## Common Workflows

### Count users on a platform
```
tesseract_get_platform_users(platform="zoom")
```

### Find an API endpoint
```
tesseract_search_endpoints(platform="ringcentral", query="call queues")
```

### Call a platform API
```
tesseract_call_platform_api(platform="zoom", method="GET", path="/api/phone/users")
```

### Migrate a user (e.g., RC to Zoom)
```
1. tesseract_get_migration_guide(source="ringcentral", target="zoom")
2. Follow the guide step by step
```

### Onboard a new company
```
1. tesseract_onboard_company(email="jeff.searcy+acme@cloudwarriors.ai", password="...", company_name="Acme Corp")
2. tesseract_get_platform_requirements(platform="zoom") → see what credentials are needed
3. tesseract_setup_platform(user_email="jeff.searcy+acme@cloudwarriors.ai", platform="zoom", credentials={...})
4. tesseract_connect_as(email="jeff.searcy+acme@cloudwarriors.ai") → switch to that company's creds
```

## ETL Database Resources

The `tesseract_query_etl` tool queries the internal ETL database (NOT platform APIs):
- `platforms` -- Registered phone platforms
- `job_types` -- Available migration types (e.g., teams_to_zoom_users)
- `jobs` / `job_status` -- ETL job tracking
- `job_groups` -- Job group management
- `extractors` / `loaders` -- Extraction and loading plans
- `data_records` -- Records at each ETL stage
- `field_mappings` -- AI-generated source-to-target field mappings
