# Presales Ops Support Channel IDs

These are the Zoom support-bot channel IDs decoded from the provided Zoom Team
Chat launch links. They are used by the OpenClaw runtime config bindings for the
two hub agents only.

## Dev

```text
PE_SUPPORT_ZOOM_CHANNEL_ID=dac54ad5319b4edcbfc62c6d2536585e@conference.xmpp.zoom.us
BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID=2f4eb447a6d8489c85348c6036453c68@conference.xmpp.zoom.us
```

## Prod

```text
PE_SUPPORT_ZOOM_CHANNEL_ID=dfa30a04d2c54c3d91637ffd3f783a76@conference.xmpp.zoom.us
BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID=2f0215142a4249ee9ad7ea2acb838895@conference.xmpp.zoom.us
```

## Notes

- Apply dev IDs only on dev-box.
- Apply prod IDs only on prod-box.
- This support-bot rollout binds only:
  - `presales-pebot`
  - `bighead-presales`
- Event/debug channels are not used by this bundle yet.
