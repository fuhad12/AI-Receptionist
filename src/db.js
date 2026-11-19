import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing in .env: SUPABASE_URL and SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// One shared Supabase client (service_role key, server side only)
export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);