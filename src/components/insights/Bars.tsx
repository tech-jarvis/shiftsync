/**
 * Table-embedded magnitude bars.
 *
 * Deliberately not a charting library. In a dense ops table the exact number
 * matters as much as the shape, so the bar sits BESIDE the figure rather than
 * replacing it -- which also means identity and value never depend on colour
 * alone, and the table itself is the accessible data view.
 *
 * Mark specs applied: 4px rounded data-end anchored to the baseline, a 2px
 * surface gap between adjacent fills, recessive track.
 */

export function HoursBar({
  regularHours,
  overtimeHours,
  max,
}: {
  regularHours: number;
  overtimeHours: number;
  max: number;
}) {
  const scale = (value: number) => (max > 0 ? Math.max(0, (value / max) * 100) : 0);
  const regularWidth = scale(regularHours);
  const overtimeWidth = scale(overtimeHours);

  return (
    <div
      className="relative h-2.5 w-full rounded-full overflow-hidden flex"
      style={{ background: "var(--chart-track)" }}
      role="img"
      aria-label={`${regularHours} regular hours${overtimeHours > 0 ? `, ${overtimeHours} overtime hours` : ""}`}
    >
      <span
        style={{
          width: `${regularWidth}%`,
          background: "var(--chart-regular)",
          borderRadius: overtimeWidth > 0 ? "9999px 0 0 9999px" : "9999px",
        }}
      />
      {overtimeWidth > 0 ? (
        <>
          {/* 2px surface gap so the two fills read as separate segments. */}
          <span style={{ width: 2, background: "var(--surface-raised)" }} />
          <span
            style={{
              width: `${overtimeWidth}%`,
              background: "var(--chart-overtime)",
              borderRadius: "0 9999px 9999px 0",
            }}
          />
        </>
      ) : null}
    </div>
  );
}

export function CountBar({
  value,
  max,
  color = "var(--chart-premium)",
  label,
}: {
  value: number;
  max: number;
  color?: string;
  label: string;
}) {
  const width = max > 0 ? (value / max) * 100 : 0;

  return (
    <div
      className="relative h-2.5 w-full rounded-full overflow-hidden"
      style={{ background: "var(--chart-track)" }}
      role="img"
      aria-label={label}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.max(value > 0 ? 3 : 0, width)}%`, background: color }}
      />
    </div>
  );
}

/** A legend, required whenever two fills share a bar. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex items-center gap-3 flex-wrap">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** A headline figure. Not a chart -- one number, stated plainly. */
export function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "warn" | "block";
}) {
  const color =
    tone === "warn" ? "var(--override)" : tone === "block" ? "var(--block)" : "var(--text)";

  return (
    <div className="card px-3.5 py-3">
      <div className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide">
        {label}
      </div>
      <div className="text-xl font-semibold tnum mt-1" style={{ color }}>
        {value}
      </div>
      {detail ? <div className="text-[11px] text-[var(--text-subtle)] mt-0.5">{detail}</div> : null}
    </div>
  );
}
