import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NotificationBell } from "@/components/NotificationBell";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const MANAGER_NAV = [
  { href: "/schedule", label: "Schedule" },
  { href: "/coverage", label: "Coverage" },
  { href: "/insights", label: "Insights" },
  { href: "/on-duty", label: "On duty" },
];

const STAFF_NAV = [
  { href: "/staff", label: "My shifts" },
  { href: "/staff/open", label: "Open shifts" },
  { href: "/staff/availability", label: "Availability" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = user.role === "staff" ? STAFF_NAV : MANAGER_NAV;

  return (
    <div className="min-h-dvh flex flex-col">
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--surface) 88%, transparent)" }}
      >
        <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center gap-4">
          <Link href="/" className="font-semibold tracking-tight shrink-0">
            ShiftSync
          </Link>

          <nav className="flex items-center gap-1 overflow-x-auto">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-2.5 py-1.5 text-sm rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-sunken)] whitespace-nowrap"
              >
                {item.label}
              </Link>
            ))}
            {user.role === "admin" ? (
              <Link
                href="/audit"
                className="px-2.5 py-1.5 text-sm rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-sunken)]"
              >
                Audit
              </Link>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <NotificationBell profileId={user.profileId} />
            <div className="hidden sm:block text-right leading-tight">
              <div className="text-xs font-medium">{user.fullName}</div>
              <div className="text-[11px] text-[var(--text-subtle)] capitalize">{user.role}</div>
            </div>
            <form action={signOut}>
              <button type="submit" className="btn text-xs">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[1600px] px-4 py-5">{children}</main>
    </div>
  );
}
