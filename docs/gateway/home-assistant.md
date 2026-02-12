# Home Assistant (Nabu Casa)

OpenClaw can integrate with Home Assistant through:

- outbound API calls from gateway methods (`ha.*`)
- inbound webhooks from Home Assistant to `POST /ha-webhook`

## Environment variables

Set these on the gateway host:

- `HA_CLOUD_SUBDOMAIN` (for example `vagc3w2cssi8ckst6oqryipfmhhmeqvd`)
- `HA_CLOUD_TOKEN` (Home Assistant long-lived access token)
- `HA_WEBHOOK_SECRET` (shared secret for inbound webhook auth)

Optional:

- `HA_HTTP_TIMEOUT_MS` (default `10000`)
- `HA_STATES_CACHE_TTL_SECONDS` (default `0`)
- `HA_WEBHOOK_DEDUPE_TTL_MS` (default `300000`)
- `HA_WEBHOOK_MAX_BODY_BYTES` (default `65536`)

## Gateway methods

The gateway exposes:

- `ha.ping`
- `ha.listStates`
- `ha.getState`
- `ha.callService`
- `ha.turnOn`
- `ha.turnOff`
- `ha.toggle`

## Webhook endpoint

- `POST /ha-webhook`
- header: `X-HA-Webhook-Secret: <HA_WEBHOOK_SECRET>`
- content type: `application/json`

Required JSON fields:

- `event_type` (string)
- `occurred_at` (ISO timestamp string)

Optional fields:

- `action`
- `entity_id`
- `state`
- `attributes`
- `context`

Duplicate events are deduped by `(occurred_at, action, entity_id, state)` and return:

- `200 { "ok": true, "deduped": true }`

## Curl test

```bash
curl -X POST "https://<your-gateway-host>/ha-webhook" \
  -H "Content-Type: application/json" \
  -H "X-HA-Webhook-Secret: ${HA_WEBHOOK_SECRET}" \
  -d '{
    "event_type": "state_changed",
    "occurred_at": "2026-02-12T12:34:56Z",
    "entity_id": "switch.office_plug",
    "state": "on",
    "attributes": { "friendly_name": "Office Plug" },
    "context": {}
  }'
```

## Home Assistant automation example

```yaml
rest_command:
  openclaw_ha_webhook:
    url: "https://<your-gateway-host>/ha-webhook"
    method: POST
    headers:
      X-HA-Webhook-Secret: !secret ha_webhook_secret
      Content-Type: application/json
    payload: >
      {
        "event_type": "state_changed",
        "occurred_at": "{{ now().isoformat() }}",
        "entity_id": "{{ trigger.entity_id }}",
        "state": "{{ trigger.to_state.state }}",
        "attributes": {{ trigger.to_state.attributes | tojson }},
        "context": {}
      }

automation:
  - alias: Notify OpenClaw on office plug change
    trigger:
      - platform: state
        entity_id: switch.office_plug
    action:
      - service: rest_command.openclaw_ha_webhook
```
