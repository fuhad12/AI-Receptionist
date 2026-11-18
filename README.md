# AI Receptionist (restaurant demo)

A voice AI receptionist you can demo to businesses. A prospect opens a link, taps **Start call**, and talks to a receptionist that knows their business name, hours and menu. It books tables, takes messages, and logs everything to a dashboard.

```
Prospect opens  /demo/<business>  ->  talks to the Vapi voice assistant
                                          |  tool calls + call report
                                          v
                              your server  POST /vapi?b=<business>
                                          |
                                          v
                              Supabase tables  ->  /dashboard
                              (reservations, messages, calls)  + optional email to the owner
```

## What you need
- Node.js 20 or newer
- A free [Supabase](https://supabase.com) project
- A [Vapi](https://vapi.ai) account (you need both the **private** and the **public** API key)
- [ngrok](https://ngrok.com) or any public HTTPS URL for your server (Vapi has to reach it)
- Optional: a [Resend](https://resend.com) key to email the owner on every booking

## Setup
1. `npm install`
2. **Supabase:** create a project, open *SQL Editor*, paste `schema.sql` and run it. From *Project Settings > API* copy the project URL and the `service_role` key.
3. **Vapi:** in the dashboard open *API Keys* and copy the private key and the public key.
4. `cp .env.example .env` and fill it in. Make the two secrets with:
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
5. Start the server: `npm run dev`. In another terminal run `ngrok http 3000`, put the `https://...` address in `PUBLIC_URL` (no trailing slash), then restart the server.
6. Create the demo assistant: `npm run create-assistant -- businesses/the-harbor-table.json`. It prints a demo link.
7. Open the link, allow the microphone, and try: *"Can I get a table for four this Friday at 7?"*
8. Open `/dashboard`, enter your `ADMIN_KEY`, and the booking should be there.

## Make a demo for a prospect
1. Copy `businesses/the-harbor-table.json` to `businesses/<their-name>.json`. Use lowercase letters, numbers and dashes. The file name becomes the link.
2. Fill in their real name, address, hours and menu from their Google Maps listing.
3. Run `npm run create-assistant -- businesses/<their-name>.json`.
4. Send them `PUBLIC_URL/demo/<their-name>`.

Running the command again for the same file **updates** that assistant. Add `--new` to force a fresh one.

## Cost and safety
- Each demo call uses Vapi credits. The assistant uses the cheaper `gpt-4o-mini`, and calls are capped at 5 minutes (`maxDurationSeconds` in `src/create-assistant.ts`).
- The demo link is public: anyone who has it can start calls. Share it only with the prospect, not on social media. If your tunnel or server is off, the link stops working.
- These are browser calls started by the visitor. No phone numbers are involved. The page tells visitors that calls may be recorded.
- If you ever add **outbound** phone calls with an AI voice, US rules (TCPA) require consent first. Get legal advice before you do.

## Files
| File | What it does |
|---|---|
| `src/server.ts` | Webhook for Vapi tool calls and call reports, demo page API, dashboard API |
| `src/create-assistant.ts` | Creates or updates one Vapi assistant per business file |
| `src/store.ts` | Remembers which assistant belongs to which business (`data/assistants.json`) |
| `prompts/receptionist.md` | The receptionist's instructions. `[[placeholders]]` are filled from the business file |
| `businesses/*.json` | One file per business |
| `public/demo.html` | The page prospects talk on |
| `public/dashboard.html` | Owner view of reservations, messages and calls |
| `public/vapi-web.js` | The official Vapi browser SDK, bundled. Rebuild with `npm run build:web` |
| `schema.sql` | Database tables |

## Customize
- **Behavior:** edit `prompts/receptionist.md`, then re-run `create-assistant` for each business.
- **Voice:** change `voiceId` in `src/create-assistant.ts`. Vapi's built-in voices need no extra account.
- **Smarter replies:** change `gpt-4o-mini` to `gpt-4o` in the same file (costs more per minute).

## Troubleshooting
- **"This demo link is not available":** `data/assistants.json` has no entry for that name. Run `create-assistant` on the same machine that runs the server.
- **Booking is not saved:** check the server terminal for the error. Usually `schema.sql` was not run, or `SUPABASE_SERVICE_KEY` is the wrong key.
- **Webhook returns 401:** `WEBHOOK_SECRET` changed after the assistant was created. Re-run `create-assistant`.
- **The AI gets today's date wrong:** use the demo page. It sends the restaurant's current date and time to the assistant. Vapi's dashboard test button does not.
- **Hosting later:** `data/assistants.json` is a file on the server's disk, so use a host with a persistent disk, or run `create-assistant` on the host itself.

## Status
Checked: the code type-checks, and the server was tested against stand-ins for Supabase and Vapi (auth, validation, duplicate bookings, both Vapi tool-call layouts, call logging, demo and dashboard routes). **Not yet checked:** a live call against real Vapi, a real Supabase database, and the pages in a real browser. Do a full test call yourself before showing a prospect.
