"use strict";

// Paste your Cobalt project URL and PUBLISHABLE key into these two strings.
// Never put a secret or service_role key in frontend files.
const COBALT_SUPABASE_URL = "https://vrasipvugufqypignbwc.supabase.co";
const COBALT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_AxJpx5M6lPrLwiPOyX5dDQ_5cydn3ut";

window.supabaseClient = null;
if (COBALT_SUPABASE_URL && COBALT_SUPABASE_PUBLISHABLE_KEY && window.supabase) {
  window.supabaseClient = window.supabase.createClient(
    COBALT_SUPABASE_URL,
    COBALT_SUPABASE_PUBLISHABLE_KEY,
  );
}
