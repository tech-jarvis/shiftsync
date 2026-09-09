"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

/**
 * The notification centre, updating live.
 *
 * Subscribed to INSERTs on `notifications` filtered to this recipient. The
 * filter is belt-and-braces: RLS already restricts the stream to rows the
 * viewer may read, so a subscription cannot leak someone else's notifications
 * even if the filter were wrong.
 */
export function NotificationBell({ profileId }: { profileId: string }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data } = await supabase
        .from("notifications")
        .select("id, kind, title, body, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      if (!cancelled) setItems(data ?? []);
    };

    void load();

    const channel = supabase
      .channel(`notifications:${profileId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${profileId}`,
        },
        (payload) => setItems((prev) => [payload.new as NotificationRow, ...prev].slice(0, 30)),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [profileId]);

  const unread = items.filter((item) => item.read_at === null).length;

  const markAllRead = async () => {
    const supabase = createClient();
    const unreadIds = items.filter((i) => i.read_at === null).map((i) => i.id);
    if (unreadIds.length === 0) return;

    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", unreadIds);

    setItems((prev) =>
      prev.map((i) => (i.read_at ? i : { ...i, read_at: new Date().toISOString() })),
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn text-xs relative"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
      >
        Alerts
        {unread > 0 ? (
          <span
            className="ml-1 tnum rounded-full px-1.5 text-[10px] font-bold"
            style={{ background: "var(--block)", color: "#fff" }}
          >
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 mt-2 w-[22rem] max-h-[70vh] overflow-y-auto card z-50 shadow-xl"
            style={{ boxShadow: "0 12px 32px rgba(0,0,0,0.18)" }}
          >
            <div
              className="flex items-center justify-between px-3 py-2 border-b sticky top-0"
              style={{ borderColor: "var(--border)", background: "var(--surface-raised)" }}
            >
              <span className="text-xs font-semibold">Notifications</span>
              {unread > 0 ? (
                <button type="button" onClick={markAllRead} className="text-xs text-[var(--accent)]">
                  Mark all read
                </button>
              ) : null}
            </div>

            {items.length === 0 ? (
              <p className="px-3 py-6 text-xs text-[var(--text-subtle)] text-center">
                Nothing yet.
              </p>
            ) : (
              <ul>
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="px-3 py-2.5 border-b last:border-0"
                    style={{
                      borderColor: "var(--border)",
                      background: item.read_at ? "transparent" : "var(--accent-soft)",
                    }}
                  >
                    <div className="text-xs font-medium">{item.title}</div>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">
                      {item.body}
                    </div>
                    <div className="text-[10px] text-[var(--text-subtle)] mt-1 tnum">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
