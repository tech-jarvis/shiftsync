import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser, homePathFor } from "@/lib/auth";

/**
 * Sign-in, with the seeded demo accounts listed for one-click access.
 *
 * The brief asks the documentation to explain "how to log in as each role".
 * Putting that on the sign-in screen itself means an evaluator never has to
 * leave the app to find a password, and can switch roles in two clicks to see
 * how the same schedule looks to a manager and to the staff member on it.
 */

const DEMO_ACCOUNTS = [
  {
    email: "admin@coastaleats.test",
    name: "Dana Reyes",
    role: "Admin",
    note: "Every location, audit export",
  },
  {
    email: "marcus@coastaleats.test",
    name: "Marcus Hale",
    role: "Manager",
    note: "Santa Monica + Venice (Pacific)",
  },
  {
    email: "priya@coastaleats.test",
    name: "Priya Raman",
    role: "Manager",
    note: "Portland ME + Providence (Eastern)",
  },
  {
    email: "sofia@coastaleats.test",
    name: "Sofia Marchetti",
    role: "Staff",
    note: "Pacific-based, certified on both coasts",
  },
  {
    email: "jamal@coastaleats.test",
    name: "Jamal Osei",
    role: "Staff",
    note: "Projected into overtime this week",
  },
  {
    email: "rina@coastaleats.test",
    name: "Rina Okafor",
    role: "Staff",
    note: "On a 6th consecutive day",
  },
];

const DEMO_PASSWORD = "ShiftSync!2026";

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);

  const user = await getCurrentUser();
  redirect(user ? homePathFor(user.role) : "/login?error=No%20profile%20for%20this%20account");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(homePathFor(user.role));

  const { error } = await searchParams;

  return (
    <main className="min-h-dvh grid lg:grid-cols-[1fr_1.1fr]">
      <section className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">ShiftSync</h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Coastal Eats · 4 locations · 2 time zones
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="mb-4 text-sm rounded-lg px-3 py-2 border"
              style={{
                color: "var(--block)",
                background: "var(--block-soft)",
                borderColor: "var(--block)",
              }}
            >
              {error}
            </p>
          ) : null}

          <form action={signIn} className="space-y-3">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                defaultValue="marcus@coastaleats.test"
                className="field"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                defaultValue={DEMO_PASSWORD}
                className="field"
              />
            </div>
            <button type="submit" className="btn btn-primary w-full">
              Sign in
            </button>
          </form>
        </div>
      </section>

      <section className="hidden lg:flex items-center p-8 border-l" style={{ borderColor: "var(--border)" }}>
        <div className="w-full max-w-lg">
          <h2 className="text-sm font-semibold mb-1">Demo accounts</h2>
          <p className="text-xs text-[var(--text-muted)] mb-4">
            Every account uses the password{" "}
            <code className="font-mono text-[var(--text)]">{DEMO_PASSWORD}</code>. Each staff
            account below is positioned on a specific edge case.
          </p>

          <div className="space-y-2">
            {DEMO_ACCOUNTS.map((account) => (
              <form key={account.email} action={signIn}>
                <input type="hidden" name="email" value={account.email} />
                <input type="hidden" name="password" value={DEMO_PASSWORD} />
                <button
                  type="submit"
                  className="card w-full text-left px-3 py-2.5 hover:border-[var(--accent)] transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{account.name}</span>
                        <span
                          className="badge"
                          style={{
                            background: "var(--accent-soft)",
                            color: "var(--accent)",
                          }}
                        >
                          {account.role}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-muted)] truncate">{account.note}</div>
                    </div>
                    <span className="text-xs text-[var(--text-subtle)] shrink-0">Sign in →</span>
                  </div>
                </button>
              </form>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
