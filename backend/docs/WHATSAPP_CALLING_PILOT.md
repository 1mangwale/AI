# WhatsApp Native Calling Pilot

## Status

Native WhatsApp Calling is fail-closed in MangwaleAI. V1 is limited to
user-initiated inbound support calls with human/manual handling. The backend can
receive signed WhatsApp calling webhooks, hash call/contact identifiers, and
draft support intake. It must not auto-answer, play AI audio, start outbound
callbacks, place/cancel/refund orders, or mutate vendor/rider/customer state.

Verified source anchors:
- Inbound vs business-initiated readiness split:
  `src/whatsapp/services/whatsapp-calling-readiness.service.ts:137`.
- Permission-template blocker is business-initiated only:
  `src/whatsapp/services/whatsapp-calling-readiness.service.ts:150`.
- Readiness always keeps `live_calling_available=false`:
  `src/whatsapp/services/whatsapp-calling-readiness.service.ts:222`.
- WhatsApp calling webhooks are normalized to hashed, draft-only support intake:
  `src/whatsapp/services/whatsapp-calling-support-intake.service.ts:40` and
  `src/whatsapp/controllers/webhook.controller.ts:184`.
- Admin inbound accept is a blocked preflight, not a provider action:
  `src/whatsapp/controllers/whatsapp-calling.controller.ts:45` and
  `src/whatsapp/services/whatsapp-calling-executor.service.ts:201`.

## Ownership

- Native WhatsApp Calling pilot owner: MangwaleAI backend, under
  `/api/whatsapp/calling/*` and `/api/webhook/whatsapp`.
- Mercury/Vikram/Exotel owner: PSTN/Exotel voice, Nerve one-way approved calls,
  and masked/order-gated bridge flows. Do not route native WhatsApp Calling
  through Mercury SIP/FreeSWITCH/LiveKit for v1.
- OpenClaw WhatsApp channel sends remain disabled for this pilot. OpenClaw may
  read readiness and prepare drafts, but must not start calls or send messages.

## Config Defaults

Keep these disabled until Meta approval and a separate Akash-approved live smoke
packet exist:

```env
WHATSAPP_CALLING_ENABLED=false
WHATSAPP_CALLING_META_APPROVED=false
WHATSAPP_CALLING_INBOUND_SUPPORT_ENABLED=false
WHATSAPP_CALLING_SIGNALING_MODE=graph_api
WHATSAPP_CALLING_LIVE_EXECUTOR_ENABLED=false
WHATSAPP_CALLING_PROVIDER_ADAPTER_ENABLED=false
```

`WHATSAPP_CALLING_PERMISSION_TEMPLATE_NAME` is required for business-initiated
callbacks only. It must not block user-initiated inbound support readiness.

## Required Verification

- Run the focused Jest specs for readiness, permission, webhook, executor, and
  controller boundaries.
- Run `pnpm run whatsapp:gate:calling` against the target API. The gate must
  report no provider call, no external send, no mutation, and no execution.
- Reconfirm Mercury health separately, but do not treat healthy Mercury as proof
  that native WhatsApp Calling is live-ready.
