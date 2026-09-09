import { describe, expect, it } from "vitest";
import {
  contains,
  durationHours,
  intersect,
  normalize,
  overlaps,
  subtract,
  totalHours,
  uncovered,
  union,
  MS_PER_HOUR,
} from "@/rules/interval";

/** Compact helper: h(1, 5) is the interval from hour 1 to hour 5 of epoch. */
const h = (start: number, end: number) => ({
  start: start * MS_PER_HOUR,
  end: end * MS_PER_HOUR,
});

describe("normalize", () => {
  it("sorts, merges overlapping intervals, and drops empties", () => {
    expect(normalize([h(5, 7), h(1, 3), h(2, 4), h(9, 9)])).toEqual([h(1, 4), h(5, 7)]);
  });

  it("merges adjacent intervals, since back-to-back windows are continuous coverage", () => {
    expect(normalize([h(1, 2), h(2, 3)])).toEqual([h(1, 3)]);
  });

  it("does not mutate its input", () => {
    const input = [h(1, 3), h(2, 5)];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalize(input);
    expect(input).toEqual(snapshot);
  });
});

describe("overlaps", () => {
  it("is false for intervals that merely touch, because bounds are half-open", () => {
    expect(overlaps(h(1, 2), h(2, 3))).toBe(false);
  });

  it("is true for genuine overlap regardless of argument order", () => {
    expect(overlaps(h(1, 3), h(2, 4))).toBe(true);
    expect(overlaps(h(2, 4), h(1, 3))).toBe(true);
  });
});

describe("subtract", () => {
  it("splits an interval when the hole sits inside it", () => {
    expect(subtract([h(0, 10)], [h(4, 6)])).toEqual([h(0, 4), h(6, 10)]);
  });

  it("trims from either edge", () => {
    expect(subtract([h(0, 10)], [h(0, 3)])).toEqual([h(3, 10)]);
    expect(subtract([h(0, 10)], [h(7, 10)])).toEqual([h(0, 7)]);
  });

  it("removes an interval entirely when fully covered", () => {
    expect(subtract([h(2, 5)], [h(0, 10)])).toEqual([]);
  });

  it("ignores non-overlapping holes", () => {
    expect(subtract([h(0, 2)], [h(5, 8)])).toEqual([h(0, 2)]);
  });

  it("applies multiple holes cumulatively", () => {
    expect(subtract([h(0, 12)], [h(2, 3), h(6, 8)])).toEqual([h(0, 2), h(3, 6), h(8, 12)]);
  });
});

describe("intersect", () => {
  it("keeps only shared time", () => {
    expect(intersect([h(0, 5), h(8, 12)], [h(3, 10)])).toEqual([h(3, 5), h(8, 10)]);
  });

  it("returns empty when there is no shared time", () => {
    expect(intersect([h(0, 2)], [h(4, 6)])).toEqual([]);
  });
});

describe("contains", () => {
  it("is true when a single window fully covers the target", () => {
    expect(contains([h(8, 18)], h(9, 17))).toBe(true);
  });

  it("is true when two adjacent windows jointly cover the target", () => {
    expect(contains([h(8, 12), h(12, 18)], h(9, 17))).toBe(true);
  });

  it("is false when a gap falls inside the target", () => {
    expect(contains([h(8, 12), h(13, 18)], h(9, 17))).toBe(false);
  });

  it("is false when the target extends past the coverage", () => {
    expect(contains([h(8, 16)], h(9, 17))).toBe(false);
  });

  it("treats an exactly-coincident window as covering", () => {
    expect(contains([h(9, 17)], h(9, 17))).toBe(true);
  });
});

describe("uncovered", () => {
  it("reports exactly the gap, which is what the violation message needs", () => {
    expect(uncovered([h(8, 12), h(13, 18)], h(9, 17))).toEqual([h(12, 13)]);
  });

  it("reports nothing when fully covered", () => {
    expect(uncovered([h(0, 24)], h(9, 17))).toEqual([]);
  });
});

describe("durations", () => {
  it("measures a single interval in hours", () => {
    expect(durationHours(h(9, 17))).toBe(8);
  });

  it("counts overlapping intervals only once", () => {
    expect(totalHours([h(0, 5), h(3, 8)])).toBe(8);
  });
});

describe("union", () => {
  it("merges two sets into a minimal disjoint set", () => {
    expect(union([h(0, 3)], [h(2, 6), h(9, 10)])).toEqual([h(0, 6), h(9, 10)]);
  });
});
