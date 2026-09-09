import { DateTime } from "luxon";

/**
 * Presentation helpers shared by violation messages and the UI.
 *
 * Violation text is where the brief's "clearly explain which rule was broken
 * and why" is actually earned, and a time printed in the wrong zone makes an
 * otherwise-correct explanation useless. Every formatter here takes an explicit
 * zone -- there is no "local time" default to accidentally inherit.
 */

/** e.g. "Mon 15 Jun, 09:00 PDT" */
export function formatInstant(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("EEE d LLL, HH:mm ZZZZ");
}

/** e.g. "Mon 15 Jun, 09:00-17:00 PDT", or "...23:00-03:00 (+1 day) PDT" overnight. */
export function formatRange(startMs: number, endMs: number, zone: string): string {
  const start = DateTime.fromMillis(startMs, { zone });
  const end = DateTime.fromMillis(endMs, { zone });
  const crossesMidnight = !start.hasSame(end, "day");

  return [
    start.toFormat("EEE d LLL, HH:mm"),
    "-",
    end.toFormat("HH:mm"),
    crossesMidnight ? "(+1 day)" : "",
    start.toFormat("ZZZZ"),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(" - ", "-");
}

/** The local calendar date an instant falls on, as 'YYYY-MM-DD'. */
export function localDateKey(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd");
}

/** e.g. "8h", "8h 30m", "45m" -- readable durations for warning copy. */
export function hoursLabel(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "Sat 20 Jun" -- for consecutive-day and fairness copy. */
export function formatDay(dateKey: string, zone: string): string {
  return DateTime.fromISO(dateKey, { zone }).toFormat("EEE d LLL");
}
