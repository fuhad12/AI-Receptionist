import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, getBusiness, saveBusiness, legacyAssistantId, slugOk } from "./store.js";

// Usage:
//   npm run create-assistant -- businesses/the-harbor-table.json
//   npm run create-assistant -- businesses/harlow-estates.json
//   npm run create-assistant -- businesses/harlow-estates.json --new   (force a brand new assistant)
// The file name (without .json) becomes the business "slug" and the demo link: /demo/<slug>
//
// The business file may set "type": "restaurant" (default) or "estate_agent".
// Optional fields in the business file:
//   voice_provider + voice_id   (e.g. "11labs" + a British voice ID)
//   transcriber_language        (default "en"; try "en-GB" for UK callers)

const { VAPI_API_KEY, PUBLIC_URL, WEBHOOK_SECRET } = process.env;
const API = process.env.VAPI_API_URL ?? "https://api.vapi.ai";
if (!VAPI_API_KEY || !PUBLIC_URL || !WEBHOOK_SECRET) {
  console.error("Set VAPI_API_KEY, PUBLIC_URL and WEBHOOK_SECRET in your .env file first.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const forceNew = argv.includes("--new");
const file = argv.find((a) => !a.startsWith("--")) ?? "businesses/the-harbor-table.json";
const slug = basename(file, ".json");
if (!slugOk(slug)) {
  console.error(`File name "${slug}" must be lowercase letters, numbers and dashes (it becomes the demo link).`);
  process.exit(1);
}

const cfg: Record<string, string> = JSON.parse(readFileSync(file, "utf8"));

// ---------------------------------------------------------------------------
// Business type: decides the prompt, required fields, first message and tools
// ---------------------------------------------------------------------------
const type = cfg.type ?? "restaurant";
if (type !== "restaurant" && type !== "estate_agent") {
  console.error(`Unknown type "${type}". Use "restaurant" or "estate_agent".`);
  process.exit(1);
}

const requiredByType: Record<string, string[]> = {
  restaurant: ["business_name", "business_description", "address", "hours", "menu", "policies", "max_party", "timezone"],
  estate_agent: ["business_name", "business_description", "address", "hours", "areas", "services", "listings", "policies", "timezone"],
};
const promptFileByType: Record<string, string> = {
  restaurant: "receptionist.md",
  estate_agent: "estate-agent.md",
};

const required = requiredByType[type];
const absent = required.filter((k) => !cfg[k]);
if (absent.length) {
  console.error(`${file} is missing: ${absent.join(", ")}`);
  process.exit(1);
}
try {
  new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone });
} catch {
  console.error(`"${cfg.timezone}" is not a valid timezone. Use a name like America/Chicago or Europe/London.`);
  process.exit(1);
}

// Fill the [[placeholders]] in the prompt from the business file
const prompt = readFileSync(join(ROOT, "prompts", promptFileByType[type]), "utf8").replace(
  /\[\[(\w+)\]\]/g,
  (_, k) => cfg[k] ?? `[[${k}]]`,
);
const unfilled = prompt.match(/\[\[\w+\]\]/g);
if (unfilled) {
  console.error(`Unfilled placeholders: ${[...new Set(unfilled)].join(", ")}`);
  process.exit(1);
}

// Every webhook carries ?b=<slug> so the server knows which business a call belongs to
const server = {
  url: `${PUBLIC_URL}/vapi?b=${slug}`,
  secret: WEBHOOK_SECRET,
  headers: { "x-webhook-secret": WEBHOOK_SECRET },
};

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
  server,
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const takeMessage = tool(
  "take_message",
  "Take a message for the team when the request is outside what you can handle yourself.",
  {
    name: { type: "string", description: "Caller's name, if given" },
    phone: { type: "string", description: "Callback number" },
    message: { type: "string", description: "What the caller needs, in one or two sentences" },
  },
  ["phone", "message"],
);

const bookReservation = tool(
  "book_reservation",
  "Book a table. Call this ONLY after the caller has confirmed every detail.",
  {
    guests: { type: "number", description: "Number of guests" },
    date: { type: "string", description: "YYYY-MM-DD, worked out from today's date" },
    time: { type: "string", description: "24-hour HH:MM, restaurant local time" },
    name: { type: "string", description: "Name for the booking" },
    phone: { type: "string", description: "Best callback number" },
    notes: { type: "string", description: "Occasion or special requests, only if mentioned" },
  },
  ["guests", "date", "time", "name", "phone"],
);

const captureLead = tool(
  "capture_lead",
  "Save a buyer, tenant, seller or landlord enquiry. Call this ONLY after the caller has confirmed the details.",
  {
    intent: { type: "string", description: "One of: buy, rent, sell, let" },
    area: { type: "string", description: "Area or postcode they are interested in" },
    property_type: { type: "string", description: "e.g. flat, terraced house, detached" },
    bedrooms: { type: "number", description: "Number of bedrooms, only if mentioned" },
    budget: { type: "string", description: "Budget or rent range, as the caller said it" },
    timeframe: { type: "string", description: "When they want to move, only if mentioned" },
    name: { type: "string", description: "Caller's name" },
    phone: { type: "string", description: "Best callback number" },
  },
  ["intent", "name", "phone"],
);

const requestViewing = tool(
  "request_viewing",
  "Record a viewing request. The team confirms the slot afterwards. Call this ONLY after the caller has confirmed the details.",
  {
    property: { type: "string", description: "Which property or address the caller wants to view" },
    preferred_day: { type: "string", description: "YYYY-MM-DD, worked out from today's date" },
    preferred_time: { type: "string", description: "24-hour HH:MM, UK local time" },
    name: { type: "string", description: "Caller's name" },
    phone: { type: "string", description: "Best callback number" },
  },
  ["property", "name", "phone"],
);

const toolsByType: Record<string, unknown[]> = {
  restaurant: [bookReservation, takeMessage],
  estate_agent: [captureLead, requestViewing, takeMessage],
};

// ---------------------------------------------------------------------------
// First message
// ---------------------------------------------------------------------------
const firstMessageByType: Record<string, string> = {
  restaurant: `Thanks for calling ${cfg.business_name}, this is Sam, the restaurant's AI assistant. How can I help?`,
  estate_agent: `Thanks for calling ${cfg.business_name}, this is Sam, the agency's AI assistant. How can I help?`,
};

// ---------------------------------------------------------------------------
// Voice (Vapi's built-in voice by default; override in the business file)
// ---------------------------------------------------------------------------
const voice =
  cfg.voice_provider && cfg.voice_id
    ? { provider: cfg.voice_provider, voiceId: cfg.voice_id }
    : { provider: "vapi", voiceId: "Elliot" }; // built-in, no extra account needed

const assistant = {
  name: `Receptionist - ${cfg.business_name}`,
  firstMessage: firstMessageByType[type],
  model: {
    provider: "openai",
    model: "gpt-4o-mini", // cheaper, so free credits last longer. Switch to "gpt-4o" if replies feel weak.
    temperature: 0.5,
    messages: [{ role: "system", content: prompt }],
    tools: toolsByType[type],
  },
  voice,
  transcriber: { provider: "deepgram", model: "nova-3", language: cfg.transcriber_language ?? "en" },
  server,
  serverMessages: ["tool-calls", "end-of-call-report"],
  // Vapi gives up on the call summary after 5 seconds by default, which leaves it empty. Allow longer.
  analysisPlan: { summaryPlan: { enabled: true, timeoutSeconds: 30 } },
  endCallFunctionEnabled: true,
  maxDurationSeconds: 300, // caps the cost of any single demo call
  silenceTimeoutSeconds: 20,
};

// Re-use the existing assistant for this business if there is one (Supabase first, then the old local file)
const existing = forceNew ? undefined : ((await getBusiness(slug))?.id ?? legacyAssistantId(slug));
const res = await fetch(existing ? `${API}/assistant/${existing}` : `${API}/assistant`, {
  method: existing ? "PATCH" : "POST",
  headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(assistant),
});
const body: any = await res.json().catch(() => ({}));
if (!res.ok || !body.id) {
  console.error(`Vapi rejected the request (${res.status}):`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

try {
  await saveBusiness({ slug, id: body.id, name: cfg.business_name, timezone: cfg.timezone });
} catch (e: any) {
  console.error(`The assistant was ${existing ? "updated" : "created"} (id ${body.id}), but saving it to Supabase failed: ${e.message}`);
  console.error('Did you run the "businesses" table block from schema.sql in the Supabase SQL editor?');
  process.exit(1);
}

console.log(`${existing ? "Updated" : "Created"} ${type} assistant ${body.id} for ${cfg.business_name}`);
console.log(`Demo link:  ${PUBLIC_URL}/demo/${slug}`);