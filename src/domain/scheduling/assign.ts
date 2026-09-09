import { isPgError, PG_ERRORS, sql } from "@/db/client";
import { withStaffLock, type Tx } from "@/db/transaction";
import { managersOfLocation, notify } from "@/domain/notifications";
import {
  formatRange,
  validateAssignment,
  type HoursProjection,
  type Violation,
} from "@/rules";
import {
  loadExistingAssignments,
  loadSettings,
  loadShiftSnapshot,
  loadStaffSnapshot,
} from "./hydrate";
import { suggestAlternatives, type Suggestion } from "./suggest";

/**
 * The assignment write path.
 *
 * Layering, and why each layer exists:
 *
 *   ADVISORY LOCK   serializes writes for this staff member, so the multi-row
 *                   rules (weekly hours, consecutive days) cannot be defeated
 *                   by two concurrent writers each reading a stale total.
 *   RULES ENGINE    decides and, crucially, EXPLAINS. Runs before the write so
 *                   the common case is a clear message rather than an error.
 *   DB CONSTRAINT   the backstop. If a racing transaction commits between our
 *                   validation and our INSERT, the exclusion constraint rejects
 *                   us with SQLSTATE 23P01 and we re-run the engine to turn
 *                   that into the same sentence the pre-check would have given.
 *
 * The third layer is what makes brief scenario 4 correct rather than merely
 * unlikely: there is no window in which two managers both succeed.
 */

export type AssignOutcome =
  | {
      status: "assigned";
      assignmentId: string;
      warnings: Violation[];
      projection: HoursProjection;
    }
  | {
      /** Rules refused it outright. */
      status: "rejected";
      violations: Violation[];
      suggestions: Suggestion[];
    }
  | {
      /** Legal, but only with a documented manager override (7th consecutive day). */
      status: "override_required";
      violations: Violation[];
    }
  | {
      /** We lost a race: another transaction committed between validate and insert. */
      status: "conflict";
      violations: Violation[];
      suggestions: Suggestion[];
    }
  | { status: "not_found"; message: string };

export interface AssignParams {
  actorId: string | null;
  shiftId: string;
  staffId: string;
  /** Supplying a reason authorises rules whose severity is `override_required`. */
  override?: { reason: string };
  now?: number;
}

export async function assignStaffToShift(params: AssignParams): Promise<AssignOutcome> {
  const { actorId, shiftId, staffId } = params;

  try {
    return await withStaffLock(actorId, [staffId], async (tx) => {
      const [settings, shift, staff] = await Promise.all([
        loadSettings(tx),
        loadShiftSnapshot(tx, shiftId),
        loadStaffSnapshot(tx, staffId),
      ]);

      if (!shift) return { status: "not_found", message: "Shift not found." } as const;
      if (!staff) return { status: "not_found", message: "Staff member not found." } as const;

      const existing = await loadExistingAssignments(tx, {
        staffId,
        aroundStart: shift.startsAt,
        aroundEnd: shift.endsAt,
      });

      const result = validateAssignment({
        staff,
        shift,
        existing,
        settings,
        now: params.now,
      });

      if (result.blocked) {
        return {
          status: "rejected",
          violations: result.violations,
          suggestions: await suggestAlternatives(shiftId, {
            settings,
            excludeStaffIds: [staffId],
            tx,
            now: params.now,
          }),
        } as const;
      }

      if (result.requiresOverride && !params.override) {
        return { status: "override_required", violations: result.violations } as const;
      }

      const [assignment] = await tx<{ id: string }[]>`
        insert into assignments (shift_id, staff_id, assigned_by)
        values (${shiftId}, ${staffId}, ${actorId})
        returning id
      `;

      // Record the documented reason alongside the assignment it authorises, so
      // an auditor can see WHY a 7th consecutive day was permitted.
      if (params.override && result.overrideCodes.length > 0) {
        for (const code of result.overrideCodes) {
          await tx`
            insert into rule_overrides (assignment_id, rule_code, severity, reason, approved_by)
            values (${assignment.id}, ${code}, 'override_required',
                    ${params.override.reason}, ${actorId})
          `;
        }
      }

      await notify(tx, {
        recipientId: staffId,
        kind: "shift_assigned",
        title: `New shift at ${shift.locationName}`,
        body: `You have been assigned ${formatRange(shift.startsAt, shift.endsAt, shift.locationTimezone)}.`,
        entityType: "shifts",
        entityId: shiftId,
      });

      // Overtime is the manager's cost decision, so tell the managers too.
      if (result.warnings.some((w) => w.code === "WEEKLY_OVERTIME")) {
        for (const managerId of await managersOfLocation(tx, shift.locationId)) {
          await notify(tx, {
            recipientId: managerId,
            kind: "overtime_warning",
            title: `Overtime: ${staff.fullName}`,
            body: result.warnings.find((w) => w.code === "WEEKLY_OVERTIME")!.message,
            entityType: "shifts",
            entityId: shiftId,
          });
        }
      }

      return {
        status: "assigned",
        assignmentId: assignment.id,
        warnings: result.warnings,
        projection: result.projection,
      } as const;
    });
  } catch (error) {
    // A racing transaction committed between our validation and our insert. The
    // transaction is aborted, so the explanation is rebuilt on a fresh
    // connection rather than inside the dead one.
    if (isPgError(error, PG_ERRORS.EXCLUSION_VIOLATION)) {
      return explainLostRace(params);
    }

    // Headcount and pending-cap triggers raise with a human message already.
    if (
      isPgError(error, PG_ERRORS.CHECK_VIOLATION) ||
      isPgError(error, PG_ERRORS.RAISE_EXCEPTION)
    ) {
      const settings = await loadSettings();
      return {
        status: "rejected",
        violations: [
          {
            code: "SHIFT_FULL",
            severity: "block",
            message: (error as { message?: string }).message ?? "The assignment was refused.",
          },
        ],
        suggestions: await suggestAlternatives(params.shiftId, {
          settings,
          excludeStaffIds: [params.staffId],
          now: params.now,
        }),
      };
    }

    throw error;
  }
}

/**
 * Re-run the engine after the database refused us, so the manager gets the same
 * precise sentence they would have got had they been a moment slower.
 */
async function explainLostRace(params: AssignParams): Promise<AssignOutcome> {
  const settings = await loadSettings();
  const [shift, staff] = await Promise.all([
    loadShiftSnapshot(sql, params.shiftId),
    loadStaffSnapshot(sql, params.staffId),
  ]);

  if (!shift || !staff) {
    return { status: "not_found", message: "Shift or staff member no longer exists." };
  }

  const existing = await loadExistingAssignments(sql, {
    staffId: params.staffId,
    aroundStart: shift.startsAt,
    aroundEnd: shift.endsAt,
  });

  const result = validateAssignment({ staff, shift, existing, settings, now: params.now });

  return {
    status: "conflict",
    violations:
      result.violations.length > 0
        ? result.violations
        : [
            {
              code: "DOUBLE_BOOKED",
              severity: "block",
              message:
                `${staff.fullName} was assigned to a conflicting shift moments ago by someone ` +
                `else. Your change was not saved.`,
            },
          ],
    suggestions: await suggestAlternatives(params.shiftId, {
      settings,
      excludeStaffIds: [params.staffId],
      now: params.now,
    }),
  };
}

/**
 * Release someone from a shift, preserving the row.
 *
 * Status moves to 'released' rather than the row being deleted: history stays
 * intact for the audit trail, and the partial index means a released row no
 * longer blocks the replacement assignment.
 */
export async function releaseAssignment(options: {
  actorId: string | null;
  assignmentId: string;
  notifyStaff?: boolean;
}): Promise<{ released: boolean }> {
  return withStaffLockForAssignment(options.assignmentId, options.actorId, async (tx) => {
    const [released] = await tx<
      { staffId: string; shiftId: string; locationName: string; locationTimezone: string;
        startsAt: Date; endsAt: Date }[]
    >`
      update assignments a
         set status = 'released', released_at = now()
        from shifts s, locations l
       where a.id = ${options.assignmentId}
         and a.status = 'active'
         and s.id = a.shift_id
         and l.id = s.location_id
      returning a.staff_id as "staffId", a.shift_id as "shiftId",
                l.name as "locationName", l.timezone as "locationTimezone",
                a.starts_at as "startsAt", a.ends_at as "endsAt"
    `;

    if (!released) return { released: false };

    if (options.notifyStaff !== false) {
      await notify(tx, {
        recipientId: released.staffId,
        kind: "shift_unassigned",
        title: `Removed from a shift at ${released.locationName}`,
        body: `You are no longer scheduled for ${formatRange(
          released.startsAt.getTime(),
          released.endsAt.getTime(),
          released.locationTimezone,
        )}.`,
        entityType: "shifts",
        entityId: released.shiftId,
      });
    }

    return { released: true };
  });
}

/** Look up the assignment's owner so the correct staff lock can be taken. */
async function withStaffLockForAssignment<T>(
  assignmentId: string,
  actorId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const [row] = await sql<{ staffId: string }[]>`
    select staff_id as "staffId" from assignments where id = ${assignmentId}
  `;
  return withStaffLock(actorId, row ? [row.staffId] : [], fn);
}
