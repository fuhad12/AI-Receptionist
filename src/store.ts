import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db } from "./db.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s);

// Which Vapi assistant belongs to which business. Stored in Supabase (table "businesses"),
// so it survives restarts and works on a hosted server.
export type Business = { slug: string; id: string; name: string; timezone: string };

const fromRow = (r: any): Business => ({ slug: r.slug, id: r.assistant_id, name: r.name, timezone: r.timezone });

// Small cache so a busy webhook doesn't hit the database on every request
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Business }>();

export async function getBusiness(slug: string): Promise<Business | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { data, error } = await db.from("businesses").select("*").eq("slug", slug).limit(1);
  if (error) {
    console.error("businesses lookup failed:", error.message);
    return hit?.value ?? null; // fall back to the last known value if the database blips
  }
  if (!data?.length) return null; // not cached, so a business you just created shows up straight away
  const value = fromRow(data[0]);
  cache.set(slug, { at: Date.now(), value });
  return value;
}

export async function listBusinesses(): Promise<Business[]> {
  const { data, error } = await db.from("businesses").select("*").order("name", { ascending: true });
  if (error) {
    console.error("businesses list failed:", error.message);
    return [];
  }
  return (data ?? []).map(fromRow);
}

export async function saveBusiness(b: Business): Promise<void> {
  const { error } = await db.from("businesses").upsert(
    { slug: b.slug, assistant_id: b.id, name: b.name, timezone: b.timezone, updated_at: new Date().toISOString() },
    { onConflict: "slug" },
  );
  if (error) throw new Error(error.message);
  cache.delete(b.slug);
}

// One-time migration helper: the older version kept this list in data/assistants.json on your computer.
export function legacyAssistantId(slug: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(ROOT, "data", "assistants.json"), "utf8"))?.[slug]?.id;
  } catch {
    return undefined;
  }
}