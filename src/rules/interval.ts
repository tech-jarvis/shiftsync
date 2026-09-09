/**
 * Half-open interval algebra over epoch milliseconds.
 *
 * Every scheduling question in ShiftSync -- "is this shift inside an available
 * window?", "do these two assignments overlap?", "how many hours did this
 * person work on Tuesday?" -- reduces to set operations on time intervals. Doing
 * that arithmetic on plain numbers, once, keeps timezone reasoning confined to
 * the boundary where instants are constructed (see availability.ts).
 *
 * Intervals are half-open [start, end): an interval ending at exactly T does not
 * contain T. This matches Postgres `tstzrange` semantics, which is what makes
 * the "exactly 10 hours of rest is allowed" boundary agree between the rules
 * engine and the database exclusion constraint.
 */

export interface Interval {
  /** Inclusive lower bound, epoch ms. */
  start: number;
  /** Exclusive upper bound, epoch ms. */
  end: number;
}

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;

export function isEmpty(i: Interval): boolean {
  return i.end <= i.start;
}

export function durationHours(i: Interval): number {
  return isEmpty(i) ? 0 : (i.end - i.start) / MS_PER_HOUR;
}

export function totalHours(intervals: Interval[]): number {
  return normalize(intervals).reduce((sum, i) => sum + durationHours(i), 0);
}

/** True when two intervals share at least one instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Sort, drop empties, and merge touching or overlapping intervals into a
 * minimal disjoint set. Adjacent intervals ([1,2) and [2,3)) merge, because for
 * availability purposes back-to-back windows are continuous coverage.
 */
export function normalize(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => !isEmpty(i)).sort((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Union of two interval sets. */
export function union(a: Interval[], b: Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

/** Everything in `from` that is not in `cut`. */
export function subtract(from: Interval[], cut: Interval[]): Interval[] {
  const holes = normalize(cut);
  let result = normalize(from);

  for (const hole of holes) {
    const next: Interval[] = [];
    for (const piece of result) {
      if (!overlaps(piece, hole)) {
        next.push(piece);
        continue;
      }
      // Left remainder
      if (piece.start < hole.start) next.push({ start: piece.start, end: hole.start });
      // Right remainder
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
    }
    result = next;
  }
  return normalize(result);
}

/** Intersection of two interval sets. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const left = normalize(a);
  const right = normalize(b);
  const result: Interval[] = [];

  for (const l of left) {
    for (const r of right) {
      const start = Math.max(l.start, r.start);
      const end = Math.min(l.end, r.end);
      if (start < end) result.push({ start, end });
    }
  }
  return normalize(result);
}

/** True when `cover` fully contains `target`, leaving no uncovered gap. */
export function contains(cover: Interval[], target: Interval): boolean {
  if (isEmpty(target)) return true;
  return subtract([target], cover).length === 0;
}

/** The parts of `target` that `cover` does NOT reach -- i.e. what to complain about. */
export function uncovered(cover: Interval[], target: Interval): Interval[] {
  return subtract([target], cover);
}
