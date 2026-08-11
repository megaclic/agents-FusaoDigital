# Z-PRO / FusaoChatBot CRM — external API reference

This is a pointer doc, not a subsystem guide (see [`docs/zpro.md`](zpro.md) for that). It exists so the external Z-PRO v4 API's shape doesn't have to be reverse-engineered from `ZproClient` again — the vendor-provided reference lives in the repo and this file says where and how it maps to our code.

## Where the spec lives

The vendor's Postman collection (`FUSAOBOT v4.x.x.x`) is saved at [`docs/reference/FUSAOBOT v4.x.x.x.postman_collection.json`](reference/FUSAOBOT%20v4.x.x.x.postman_collection.json). It documents every REST endpoint of the external Z-PRO API — appointments/reminders, campaigns, channels/sessions, contacts, CRM pipeline, dashboard, bulk dispatch, gallery, WhatsApp groups, per-channel interactive messages (Baileys/Instagram/Messenger/UazAPI/WABA), kanban/tags/reasons/queues, tickets, users, and tenant administration. Import it into Postman (or read the raw JSON) when you need the exact request/response shape for an endpoint `ZproClient` doesn't cover yet, or to double-check a shape `ZproClient` already wraps.

## URL / auth pattern (already hardcoded in our client)

Every endpoint follows `{baseUrl}/v2/api/external/{apiId}/...` with a Bearer token — see `ZproClient.endpoint()` in `src/modules/zpro/client.ts`. `apiId` is the UUID segment right after `external/` in the URL the Z-PRO panel gives operators (e.g. `https://api.fusaobotcrm.com.br/v2/api/external/b4c2ae0c-bb48-41fa-9c28-7812d4797775`) — the "add instance" form (`src/client/pages/ZproSection.tsx`) extracts it automatically from a pasted full URL via `extractZproCredentialsFromUrl` (`src/client/lib/zpro.ts`), so operators only ever paste one string.

## Most of `ZproClient` is unused today

`docs/zpro.md` already flags this: `ZproClient` is a ~90-method wrapper built ahead of the UI/tools that will call it. `runZproAgentTurn` (`src/modules/zpro/runtime.ts`) only uses `sendTyping`/`sendText` today (see `messages.ts`). If you're adding a new agent tool or admin feature backed by one of these methods, check this file's collection first for the exact request/response shape instead of guessing from the method name.

## Google Calendar vs. the "Agendamentos e Lembretes" API — do not conflate these

Confirmed against Z-PRO's own help center (MCP `central-de-ajuda-z-pro`, 2026-08-11): these are two unrelated features.

- **Google Calendar** ("Eventos do Google Calendar") is a native Z-PRO feature requiring a Google account connected via OAuth (`Configurações → Integrações → Google Calendar` in the Z-PRO panel; `Client ID`/`Client Secret` configured at the tenant or global level). Events created there sync in real time with the connected Google Calendar. There is a "Google Agenda" interaction available in Z-PRO's own Chat Flow builder, but **no endpoint for it appears in the Postman collection** — it is not reachable through the external API our `ZproClient` talks to.
- **`AppointmentCreate`/`AppointmentUpdate`/`ScheduleReminderCreate`/…** (the "📅 Agendamentos e Lembretes" folder in the collection, under "Agenda" in the Z-PRO panel: `Consultas`/`Calendário`/`Lembretes` tabs) is an **internal WhatsApp appointment/reminder scheduler** — no documented sync with Google Calendar. `ZproClient` already wraps these methods (`createAppointment`, `listAppointments`, `createReminder`, etc. in `src/modules/zpro/client.ts`), but none of them are called from any tool, controller, or service today — dead code, same as most of the rest of the client.

If a future agent tool needs to "create a calendar event," decide explicitly which of these two it means — they are not interchangeable, and only the Z-PRO panel (not this API) can create a real Google Calendar event today.
