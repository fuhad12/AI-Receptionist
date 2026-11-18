import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, readStore, writeStore, slugOk } from "./store.js";

// Usage:
//   npm run create-assistant -- businesses/the-harbor-table.json
//   npm run create-assistant -- businesses/the-harbor-table.json --new   (force a brand new assistant)
// The file name (without .json) becomes the business "slug" and the demo link: /demo/<slug>

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
const required = ["business_name", "business_description", "address", "hours", "menu", "policies", "max_party", "timezone"];
const absent = required.filter((k) => !cfg[k]);
if (absent.length) {
  console.error(`${file} is missing: ${absent.join(", ")}`);
  process.exit(1);
}
try {
  new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone });
} catch {
  console.error(`"${cfg.timezone}" is not a valid timezone. Use a name like America/Chicago.`);
  process.exit(1);
}

// Fill the [[placeholders]] in the prompt from the business file
const prompt = readFileSync(join(ROOT, "prompts", "receptionist.md"), "utf8").replace(
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

const assistant = {
  name: `Receptionist - ${cfg.business_name}`,
  firstMessage: `Thanks for calling ${cfg.business_name}, this is Sam, the restaurant's AI assistant. How can I help?`,
  model: {
    provider: "openai",
    model: "gpt-4o-mini", // cheaper, so free credits last longer. Switch to "gpt-4o" if replies feel weak.
    temperature: 0.5,
    messages: [{ role: "system", content: prompt }],
    tools: [
      tool(
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
      ),
      tool(
        "take_message",
        "Take a message for the team when the request is outside what you can handle yourself.",
        {
          name: { type: "string", description: "Caller's name, if given" },
          phone: { type: "string", description: "Callback number" },
          message: { type: "string", description: "What the caller needs, in one or two sentences" },
        },
        ["phone", "message"],
      ),
    ],
  },
  voice: { provider: "vapi", voiceId: "Elliot" }, // Vapi's built-in voice, no extra account needed
  transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
  server,
  serverMessages: ["tool-calls", "end-of-call-report"],
  // Vapi gives up on the call summary after 5 seconds by default, which leaves it empty. Allow longer.
  analysisPlan: { summaryPlan: { enabled: true, timeoutSeconds: 30 } },
  endCallFunctionEnabled: true,
  maxDurationSeconds: 300, // caps the cost of any single demo call
  silenceTimeoutSeconds: 20,
};

const store = readStore();
const existing = forceNew ? undefined : store[slug]?.id;
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

store[slug] = { id: body.id, name: cfg.business_name, timezone: cfg.timezone, updatedAt: new Date().toISOString() };
writeStore(store);

console.log(`${existing ? "Updated" : "Created"} assistant ${body.id} for ${cfg.business_name}`);
console.log(`Demo link:  ${PUBLIC_URL}/demo/${slug}`);