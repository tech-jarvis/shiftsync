import type { Tx } from "@/db/transaction";

/**
 * Notification writing.
 *
 * Only the in-app row is written here. Fan-out to the simulated email channel
 * is a database trigger on `notifications`, so every code path that notifies
 * somebody gets email simulation for free and none can forget it.
 */

export type NotificationKind =
  | "shift_assigned"
  | "shift_changed"
  | "shift_unassigned"
  | "schedule_published"
  | "swap_requested"
  | "swap_accepted"
  | "swap_rejected"
  | "swap_withdrawn"
  | "swap_cancelled"
  | "swap_approved"
  | "drop_offered"
  | "drop_claimed"
  | "drop_expired"
  | "approval_needed"
  | "overtime_warning"
  | "availability_changed";

export interface NotificationInput {
  recipientId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
}

export async function notify(tx: Tx, notification: NotificationInput): Promise<void> {
  await tx`
    insert into notifications (recipient_id, kind, title, body, entity_type, entity_id)
    values (
      ${notification.recipientId},
      ${notification.kind},
      ${notification.title},
      ${notification.body},
      ${notification.entityType ?? null},
      ${notification.entityId ?? null}
    )
  `;
}

export async function notifyMany(tx: Tx, notifications: NotificationInput[]): Promise<void> {
  for (const notification of notifications) {
    await notify(tx, notification);
  }
}

/** Every manager responsible for a location -- the audience for approvals. */
export async function managersOfLocation(tx: Tx, locationId: string): Promise<string[]> {
  const rows = await tx<{ managerId: string }[]>`
    select manager_id as "managerId" from manager_locations where location_id = ${locationId}
  `;
  return rows.map((r) => r.managerId);
}
