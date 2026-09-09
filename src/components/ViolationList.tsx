import type { Violation } from "@/rules/types";

/**
 * Rendering violations.
 *
 * The brief requires the system to "clearly explain which rule was broken and
 * why". Three severities read differently on purpose:
 *
 *   block             red    -- you cannot do this
 *   override_required orange -- you may, with a documented reason
 *   warn              amber  -- you may, but know the cost
 *
 * Colour alone never carries the meaning: each row is also labelled, so the
 * distinction survives greyscale printing and colour-blind readers.
 */

const STYLES = {
  block: { label: "Blocked", fg: "var(--block)", bg: "var(--block-soft)" },
  override_required: { label: "Needs override", fg: "var(--override)", bg: "var(--override-soft)" },
  warn: { label: "Warning", fg: "var(--warn)", bg: "var(--warn-soft)" },
} as const;

export function SeverityBadge({ severity }: { severity: Violation["severity"] }) {
  const style = STYLES[severity];
  return (
    <span className="badge" style={{ background: style.bg, color: style.fg }}>
      {style.label}
    </span>
  );
}

export function ViolationList({
  violations,
  compact = false,
}: {
  violations: Violation[];
  compact?: boolean;
}) {
  if (violations.length === 0) return null;

  return (
    <ul className={compact ? "space-y-1" : "space-y-1.5"}>
      {violations.map((violation, index) => {
        const style = STYLES[violation.severity];
        return (
          <li
            key={`${violation.code}-${index}`}
            className="rounded-md px-2.5 py-1.5 text-xs leading-relaxed border"
            style={{ background: style.bg, borderColor: style.fg, color: "var(--text)" }}
          >
            <span
              className="font-semibold mr-1.5"
              style={{ color: style.fg }}
            >
              {style.label}:
            </span>
            {violation.message}
          </li>
        );
      })}
    </ul>
  );
}

/** A one-line summary for dense contexts like a roster row. */
export function ViolationSummary({ violations }: { violations: Violation[] }) {
  if (violations.length === 0) {
    return (
      <span className="badge" style={{ background: "var(--ok-soft)", color: "var(--ok)" }}>
        No issues
      </span>
    );
  }

  const worst = violations[0];
  const style = STYLES[worst.severity];
  const extra = violations.length - 1;

  return (
    <span className="badge" style={{ background: style.bg, color: style.fg }}>
      {style.label}
      {extra > 0 ? ` +${extra}` : ""}
    </span>
  );
}
