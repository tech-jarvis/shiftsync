"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for the browser.
 *
 * Also the realtime transport: subscriptions opened with this client are
 * evaluated against the same RLS policies as ordinary reads, so a staff member
 * cannot receive change events for a draft schedule they are not allowed to see.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
