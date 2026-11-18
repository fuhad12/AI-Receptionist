import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ROOT, readStore, slugOk } from "./store.js";

// ---------- config ----------
const env = process.env;
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "WEBHOOK_SECRET", "ADMIN_KEY", "VAPI_PUBLIC_KEY"] as const;
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}
const WEBHOOK_SECRET = env.WEBHOOK_SECRET!;
const ADMIN_KEY = env.ADMIN_KEY!;
const PORT = Number(env.PORT ?? 3000);
const VAPI_API_KEY = env.VAPI_API_KEY; // private key, only used to fetch recordings
const VAPI_API = env.VAPI_API_URL ?? "https://api.vapi.ai";
const db = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------- helpers ----------
async function notifyOwner(subject: string, text: string) {
  const { RESEND_API_KEY, OWNER_EMAIL, MAIL_FROM } = env;
  if (!RESEND_API_KEY || !OWNER_EMAIL) return;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM ?? "onboarding@resend.dev", to: [OWNER_EMAIL], subject, text }),
    });
    if (!r.ok) console.error("Email failed:", r.status, await r.text());
  } catch (e) {
    console.error("Email failed:", e);
  }
}

const parseArgs = (a: unknown): Record<string, any> => {
  if (a && typeof a === "object") return a as Record<string, any>;
  try { return JSON.parse(String(a ?? "{}")); } catch { return {}; }
};

type Tool = { id: string; name: string; args: Record<string, any> };

// Vapi sends tool calls in one of two layouts, so read both
function extractTools(msg: any): Tool[] {
  const list: any[] = msg.toolCallList ?? [];
  if (list.length) {
    return list.map((t) => ({
      id: t.id ?? t.toolCallId,
      name: t.function?.name ?? t.name,
      args: parseArgs(t.function?.arguments ?? t.arguments ?? t.parameters),
    }));
  }
  return (msg.toolWithToolCallList ?? []).map((t: any) => ({
    id: t.toolCall?.id,
    name: t.name ?? t.toolCall?.function?.name,
    args: parseArgs(t.toolCall?.parameters ?? t.toolCall?.function?.arguments),
  }));
}

const pick = (...v: any[]) => v.find((x) => x !== undefined && x !== null && x !== "");

// Recording URLs come nested inside an object; find the first one
function firstUrl(o: any): string | undefined {
  if (typeof o === "string") return /^https?:\/\//.test(o) ? o : undefined;
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) {
      const u = firstUrl(v);
      if (u) return u;
    }
  }
  return undefined;
}

const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD

// ---------- tools ----------
async function bookReservation(slug: string, callId: string | undefined, a: Record<string, any>): Promise<string> {
  const guests = Number(a.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > 50) return "I need a valid number of guests. Ask the caller.";

  const date = String(a.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return "I need an exact calendar date. Ask the caller to confirm the day.";
  }
  const tz = readStore()[slug]?.timezone ?? "UTC";
  if (date < todayIn(tz)) return "That date has already passed. Ask the caller for a future date.";

  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(a.time ?? ""));
  if (!m) return "I need an exact time. Ask the caller to confirm it.";
  const time = `${m[1].padStart(2, "0")}:${m[2]}`;

  const name = String(a.name ?? "").trim().slice(0, 80);
  const phone = String(a.phone ?? "").trim().slice(0, 40);
  const digits = phone.replace(/\D/g, "");
  if (!name) return "I still need the name for the booking. Ask the caller.";
  if (digits.length < 7 || digits.length > 15) return "That phone number does not look complete. Ask the caller to repeat it.";

  const notes = a.notes ? String(a.notes).slice(0, 300) : null;
  const { error } = await db.from("reservations").insert({
    business_slug: slug,
    vapi_call_id: callId ?? null,
    guest_name: name,
    phone,
    guests,
    reserve_date: date,
    reserve_time: time,
    notes,
  });

  if (error && error.code !== "23505") {
    console.error("reservation insert failed:", error);
    return "The booking could not be saved. Tell the caller the team will confirm shortly.";
  }
  if (!error) {
    const biz = readStore()[slug]?.name ?? slug;
    void notifyOwner(
      `New reservation at ${biz}: ${name}, ${guests} guests, ${date} ${time}`,
      [`Name: ${name}`, `Phone: ${phone}`, `Guests: ${guests}`, `When: ${date} at ${time}`, `Notes: ${notes ?? "-"}`].join("\n"),
    );
  }
  return `Reservation saved for ${guests} guests on ${date} at ${time} under ${name}. Confirm this to the caller.`;
}

async function takeMessage(slug: string, callId: string | undefined, a: Record<string, any>): Promise<string> {
  const message = String(a.message ?? "").trim().slice(0, 1000);
  const phone = String(a.phone ?? "").trim().slice(0, 40);
  if (!message) return "I still need to know what the caller needs. Ask them.";
  if (phone.replace(/\D/g, "").length < 7) return "I still need a complete callback number. Ask the caller.";

  const caller = a.name ? String(a.name).trim().slice(0, 80) : null;
  const { error } = await db.from("messages").insert({
    business_slug: slug,
    vapi_call_id: callId ?? null,
    caller_name: caller,
    phone,
    message,
  });
  if (error) {
    console.error("message insert failed:", error);
    return "The message could not be saved. Tell the caller the team will be in touch.";
  }
  const biz = readStore()[slug]?.name ?? slug;
  void notifyOwner(`New message at ${biz} from ${caller ?? "a caller"}`, `Name: ${caller ?? "-"}\nPhone: ${phone}\n\n${message}`);
  return "Message saved. Tell the caller the team will call them back.";
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use("/static", express.static(join(ROOT, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Vapi webhook: every assistant points here with ?b=<business slug>
app.post("/vapi", async (req: Request, res: Response) => {
  const given = req.get("x-webhook-secret") ?? req.get("x-vapi-secret") ?? "";
  if (!safeEqual(given, WEBHOOK_SECRET)) return res.sendStatus(401);

  const slug = String(req.query.b ?? "");
  if (!slugOk(slug)) return res.status(400).json({ error: "bad business" });

  const msg = req.body?.message;
  const callId: string | undefined = msg?.call?.id;

  if (msg?.type === "tool-calls") {
    const results = [];
    for (const t of extractTools(msg)) {
      let result: string;
      try {
        if (t.name === "book_reservation") result = await bookReservation(slug, callId, t.args);
        else if (t.name === "take_message") result = await takeMessage(slug, callId, t.args);
        else result = `Unknown tool ${t.name}`;
      } catch (e: any) {
        console.error(`tool ${t.name} failed:`, e);
        result = "Something went wrong. Tell the caller the team will follow up.";
      }
      results.push({ name: t.name, toolCallId: t.id, result });
    }
    return res.json({ results });
  }

  if (msg?.type === "end-of-call-report" && callId) {
    const gotSummary = pick(msg.summary, msg.analysis?.summary);
    console.log(
      `call report ${callId}: summary ${gotSummary ? "present" : "MISSING"} | fields: ${Object.keys(msg).join(",")} | analysis: ${Object.keys(msg.analysis ?? {}).join(",") || "none"}`,
    );
    const { error } = await db.from("calls").upsert(
      {
        business_slug: slug,
        vapi_call_id: callId,
        summary: pick(msg.summary, msg.analysis?.summary) ?? null,
        transcript: pick(msg.transcript, msg.artifact?.transcript) ?? null,
        recording_url: pick(msg.recordingUrl, msg.artifact?.recordingUrl, firstUrl(msg.artifact?.recording)) ?? null,
        duration_seconds: Math.round(Number(pick(msg.durationSeconds, 0))),
        ended_reason: msg.endedReason ?? null,
      },
      { onConflict: "vapi_call_id" },
    );
    if (error) console.error("call log failed:", error);
  }
  res.sendStatus(200);
});

// Shareable demo page: /demo/<slug>
app.get("/demo/:slug", (req, res) => {
  if (!slugOk(req.params.slug) || !readStore()[req.params.slug]) return res.status(404).send("Demo not found");
  res.sendFile(join(ROOT, "public", "demo.html"));
});

app.get("/api/demo/:slug", (req, res) => {
  const biz = slugOk(req.params.slug) ? readStore()[req.params.slug] : undefined;
  if (!biz) return res.status(404).json({ error: "not found" });
  res.json({ name: biz.name, assistantId: biz.id, timezone: biz.timezone, publicKey: env.VAPI_PUBLIC_KEY });
});

// Owner dashboard
const admin = (req: Request, res: Response, next: NextFunction) =>
  safeEqual(req.get("x-admin-key") ?? "", ADMIN_KEY) ? next() : res.sendStatus(401);

app.get("/dashboard", (_req, res) => res.sendFile(join(ROOT, "public", "dashboard.html")));

app.get("/api/:table(reservations|messages|calls)", admin, async (req, res) => {
  let q = db.from(req.params.table).select("*").order("created_at", { ascending: false }).limit(200);
  const b = String(req.query.b ?? "");
  if (b && slugOk(b)) q = q.eq("business_slug", b);
  const { data, error } = await q;
  if (error) {
    console.error(error);
    return res.status(500).json({ error: "database error" });
  }
  res.json(data);
});

app.get("/api/businesses", admin, (_req, res) =>
  res.json(Object.entries(readStore()).map(([slug, v]) => ({ slug, name: v.name }))),
);

// Vapi keeps call recordings in private storage, so the links in webhooks can't be opened directly.
// This asks Vapi for a fresh short-lived link when you click "Listen" on the dashboard.
app.get("/api/calls/:callId/recording", admin, async (req, res) => {
  const callId = req.params.callId;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(callId)) return res.status(400).json({ error: "bad call id" });
  if (!VAPI_API_KEY) return res.status(500).json({ error: "VAPI_API_KEY is missing from .env" });

  for (const kind of ["mono-recording", "stereo-recording"]) {
    try {
      const r = await fetch(`${VAPI_API}/call/${callId}/${kind}`, {
        headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
        redirect: "manual", // we want the signed link itself, not the audio bytes
      });
      const link = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && link) return res.json({ url: link });
      if (r.status !== 404) console.error(`recording lookup (${kind}) returned ${r.status}`);
    } catch (e) {
      console.error(`recording lookup (${kind}) failed:`, e);
    }
  }
  res.status(404).json({ error: "Recording not available for this call" });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, () => console.log(`AI receptionist server running on port ${PORT}`));