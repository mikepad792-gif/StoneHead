// lib/supabase.js
// Supabase client for StoneHead AI
// Uses service role key for server-side operations (serverless functions).
// Uses anon key for client-side / auth operations.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing Supabase env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY"
  );
}

// Client-side / auth client (uses anon key, respects RLS)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Server-side admin client (bypasses RLS for backend operations)
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
