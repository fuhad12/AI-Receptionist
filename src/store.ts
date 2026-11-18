import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "data", "assistants.json");

export type AssistantRecord = { id: string; name: string; timezone: string; updatedAt: string };
export type Store = Record<string, AssistantRecord>;

export function readStore(): Store {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}

export function writeStore(s: Store) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s);
