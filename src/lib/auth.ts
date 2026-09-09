import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "manager" | "staff";

export interface CurrentUser {
  profileId: string;
  authUserId: string;
  fullName: string;
  email: string;
  role: Role;
  homeTimezone: string;
  /** Locations this user may act on: managed for managers, all for admins. */
  locationIds: string[];
}

/**
 * The signed-in user, or null.
 *
 * Note this resolves the PROFILE, not just the auth user: profiles carry the
 * role, timezone and location scope, and exist independently of whether the
 * person has ever activated a login.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, home_timezone")
    .eq("auth_user_id", user.id)
    .single();

  if (!profile) return null;

  let locationIds: string[] = [];
  if (profile.role === "admin") {
    const { data } = await supabase.from("locations").select("id");
    locationIds = (data ?? []).map((l) => l.id);
  } else if (profile.role === "manager") {
    const { data } = await supabase
      .from("manager_locations")
      .select("location_id")
      .eq("manager_id", profile.id);
    locationIds = (data ?? []).map((l) => l.location_id);
  } else {
    const { data } = await supabase
      .from("staff_certifications")
      .select("location_id")
      .eq("staff_id", profile.id);
    locationIds = [...new Set((data ?? []).map((l) => l.location_id))];
  }

  return {
    profileId: profile.id,
    authUserId: user.id,
    fullName: profile.full_name,
    email: profile.email,
    role: profile.role as Role,
    homeTimezone: profile.home_timezone,
    locationIds,
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect(homePathFor(user.role));
  return user;
}

export function homePathFor(role: Role): string {
  return role === "staff" ? "/staff" : "/schedule";
}
