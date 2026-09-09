import { DateTime } from "luxon";
import Link from "next/link";
import { fairnessReport, weeklyLabourReport } from "@/domain/analytics";
import { requireRole } from "@/lib/auth";
import { CountBar, HoursBar, Legend, StatTile } from "@/components/insights/Bars";

/**
 * Overtime cost and schedule fairness.
 *
 * Two questions a manager gets asked out loud -- "why is payroll up?" and "how
 * come I never get Saturdays?" -- answered from the same assignment rows the
 * schedule is built from, so the report and the roster can never disagree.
 */

const currency = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; weeks?: string }>;
}) {
  const user = await requireRole("manager", "admin");
  const params = await searchParams;

  if (user.locationIds.length === 0) {
    return <p className="text-sm text-[var(--text-muted)]">No locations assigned.</p>;
  }

  const anchor = params.week ? DateTime.fromISO(params.week) : DateTime.now();
  const weekStart = anchor.startOf("day").minus({ days: anchor.weekday - 1 });

  const lookbackWeeks = Number(params.weeks ?? 4);
  const fairnessFrom = weekStart.minus({ weeks: lookbackWeeks });

  const [labour, fairness] = await Promise.all([
    weeklyLabourReport({ locationIds: user.locationIds, weekStart }),
    fairnessReport({
      locationIds: user.locationIds,
      from: fairnessFrom,
      to: weekStart.plus({ days: 7 }),
    }),
  ]);

  const totalCost = labour.reduce((sum, r) => sum + r.totalCost, 0);
  const overtimeCost = labour.reduce((sum, r) => sum + r.overtimeCost, 0);
  const inOvertime = labour.filter((r) => r.overtimeHours > 0);
  const approaching = labour.filter((r) => r.overtimeHours === 0 && r.hours >= 35);
  const maxHours = Math.max(40, ...labour.map((r) => r.hours));
  const maxPremium = Math.max(1, ...fairness.rows.map((r) => r.premiumShifts));

  const weekLink = (offset: number) =>
    `/insights?week=${weekStart.plus({ weeks: offset }).toISODate()}&weeks=${lookbackWeeks}`;

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Insights</h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5 tnum">
            Week of {weekStart.toFormat("d LLL yyyy")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Link href={weekLink(-1)} className="btn text-xs">←</Link>
          <Link href={`/insights?weeks=${lookbackWeeks}`} className="btn text-xs">This week</Link>
          <Link href={weekLink(1)} className="btn text-xs">→</Link>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Projected labour cost</h2>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatTile label="Total this week" value={currency(totalCost)} detail={`${labour.length} staff scheduled`} />
          <StatTile
            label="Overtime cost"
            value={currency(overtimeCost)}
            detail={overtimeCost > 0 ? "paid at 1.5x above 40h" : "none this week"}
            tone={overtimeCost > 0 ? "warn" : "default"}
          />
          <StatTile
            label="In overtime"
            value={String(inOvertime.length)}
            detail={inOvertime.map((r) => r.fullName.split(" ")[0]).join(", ") || "nobody"}
            tone={inOvertime.length > 0 ? "warn" : "default"}
          />
          <StatTile
            label="Approaching 40h"
            value={String(approaching.length)}
            detail={approaching.map((r) => r.fullName.split(" ")[0]).join(", ") || "nobody"}
          />
        </div>

        <div className="card overflow-hidden">
          <div
            className="flex items-center justify-between px-3 py-2 border-b"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="text-xs font-medium text-[var(--text-muted)]">Hours by staff member</span>
            <Legend
              items={[
                { label: "Regular", color: "var(--chart-regular)" },
                { label: "Overtime", color: "var(--chart-overtime)" },
              ]}
            />
          </div>

          {labour.length === 0 ? (
            <p className="px-3 py-6 text-xs text-[var(--text-subtle)] text-center">
              Nobody is scheduled this week.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--text-subtle)] uppercase tracking-wide">
                    <th className="text-left font-medium px-3 py-1.5">Staff</th>
                    <th className="text-left font-medium px-3 py-1.5 w-[30%]">Hours</th>
                    <th className="text-right font-medium px-3 py-1.5">Total</th>
                    <th className="text-right font-medium px-3 py-1.5">Target</th>
                    <th className="text-right font-medium px-3 py-1.5">Days</th>
                    <th className="text-right font-medium px-3 py-1.5">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {labour.map((row) => (
                    <tr key={row.staffId} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.fullName}</div>
                        {row.tippingShifts.length > 0 ? (
                          <div className="text-[11px] tnum" style={{ color: "var(--override)" }}>
                            Tipped into overtime by the{" "}
                            {DateTime.fromISO(row.tippingShifts[0].startsAt).toFormat("EEE")}{" "}
                            {row.tippingShifts[0].locationName.replace("Coastal Eats ", "")} shift
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <HoursBar
                          regularHours={row.regularHours}
                          overtimeHours={row.overtimeHours}
                          max={maxHours}
                        />
                      </td>
                      <td className="px-3 py-2 text-right tnum font-medium">
                        {row.hours}h
                        {row.overtimeHours > 0 ? (
                          <span className="block text-[11px]" style={{ color: "var(--override)" }}>
                            +{row.overtimeHours}h OT
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right tnum text-[var(--text-muted)]">
                        {row.desiredWeeklyHours === null ? "—" : `${row.desiredWeeklyHours}h`}
                      </td>
                      <td className="px-3 py-2 text-right tnum">
                        <span
                          style={{
                            color:
                              row.consecutiveDays >= 7
                                ? "var(--block)"
                                : row.consecutiveDays >= 6
                                  ? "var(--override)"
                                  : "var(--text-muted)",
                          }}
                        >
                          {row.consecutiveDays}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tnum">{currency(row.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold">Fairness</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Premium shifts are Friday and Saturday evenings, judged in each location&rsquo;s own
              timezone. Last {fairness.weeks} weeks.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {[4, 8, 12].map((weeks) => (
              <Link
                key={weeks}
                href={`/insights?week=${weekStart.toISODate()}&weeks=${weeks}`}
                className="px-2 py-1 text-xs rounded-md border"
                style={{
                  borderColor: weeks === lookbackWeeks ? "var(--accent)" : "var(--border)",
                  color: weeks === lookbackWeeks ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                {weeks}w
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          <StatTile label="Premium shifts" value={String(fairness.totalPremiumShifts)} detail="in the period" />
          <StatTile
            label="Distribution"
            value={fairness.premiumGini.toFixed(2)}
            detail={
              fairness.premiumGini < 0.2
                ? "Gini · evenly shared"
                : fairness.premiumGini < 0.4
                  ? "Gini · somewhat uneven"
                  : "Gini · concentrated in a few people"
            }
            tone={fairness.premiumGini >= 0.4 ? "warn" : "default"}
          />
          <StatTile
            label="Never scheduled"
            value={String(fairness.rows.filter((r) => r.premiumShifts === 0).length)}
            detail="staff with zero premium shifts"
            tone={fairness.rows.some((r) => r.premiumShifts === 0) ? "warn" : "default"}
          />
        </div>

        <div className="card overflow-hidden">
          <div className="px-3 py-2 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs font-medium text-[var(--text-muted)]">
              Premium shifts per staff member
            </span>
          </div>

          {fairness.rows.length === 0 ? (
            <p className="px-3 py-6 text-xs text-[var(--text-subtle)] text-center">
              No shifts in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--text-subtle)] uppercase tracking-wide">
                    <th className="text-left font-medium px-3 py-1.5">Staff</th>
                    <th className="text-left font-medium px-3 py-1.5 w-[28%]">Premium shifts</th>
                    <th className="text-right font-medium px-3 py-1.5">Count</th>
                    <th className="text-right font-medium px-3 py-1.5">Vs fair share</th>
                    <th className="text-right font-medium px-3 py-1.5">Avg h/week</th>
                    <th className="text-right font-medium px-3 py-1.5">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {fairness.rows.map((row) => {
                    const under = row.premiumShare < 0.6;
                    const over = row.premiumShare > 1.4;
                    return (
                      <tr key={row.staffId} className="border-t" style={{ borderColor: "var(--border)" }}>
                        <td className="px-3 py-2 font-medium">{row.fullName}</td>
                        <td className="px-3 py-2">
                          <CountBar
                            value={row.premiumShifts}
                            max={maxPremium}
                            label={`${row.fullName}: ${row.premiumShifts} premium shifts`}
                          />
                        </td>
                        <td className="px-3 py-2 text-right tnum font-medium">{row.premiumShifts}</td>
                        <td className="px-3 py-2 text-right tnum">
                          <span
                            style={{
                              color: under
                                ? "var(--override)"
                                : over
                                  ? "var(--text-muted)"
                                  : "var(--ok)",
                            }}
                          >
                            {row.premiumShare.toFixed(2)}×
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tnum">{row.averageWeeklyHours}h</td>
                        <td className="px-3 py-2 text-right tnum text-[var(--text-muted)]">
                          {row.desiredWeeklyHours === null ? "—" : `${row.desiredWeeklyHours}h`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
