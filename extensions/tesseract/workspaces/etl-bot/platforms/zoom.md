# Zoom Platform Reference

## Authentication
- **Type**: Server-to-Server OAuth (s2s_oauth)
- **Required credentials**: client_id, client_secret, account_id
- **Where to get them**: Zoom Marketplace > Build App > Server-to-Server OAuth

## Key API Paths (via gateway)
- `GET /api/phone/users` - List Zoom Phone users
- `GET /api/users` - List all Zoom users
- `GET /api/phone/sites` - List sites
- `GET /api/phone/call_queues` - List call queues
- `GET /api/phone/auto_receptionists` - List auto receptionists
- `GET /api/phone/numbers` - List phone numbers

## Platform Quirks
- `POST /phone/users` is DEPRECATED (405). Use `PATCH /users/{email}/settings` with `{"feature":{"zoom_phone":true}}` to enable Zoom Phone.
- Type 3010 = ZP Basic calling plan (no license required).
- Use `tesseract_configure_zoom_ar_ivr` for IVR -- NEVER use `tesseract_call_platform_api` for IVR key presses.
- Sites auto-create an Auto Receptionist when created.

## Provisioning Order
1. Create user (`tesseract_create_zoom_user`)
2. Enable Zoom Phone (`tesseract_enable_zoom_phone`)
3. Create site if needed (`tesseract_create_zoom_site`)
4. Create call queues (`tesseract_create_zoom_call_queue`)
5. Add users to queues (`tesseract_add_user_to_zoom_queue`)
6. Configure IVR (`tesseract_configure_zoom_ar_ivr`)
7. Assign phone numbers via API
