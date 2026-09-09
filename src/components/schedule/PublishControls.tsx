"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setWeekPublished } from "@/app/(app)/schedule/actions";

export function PublishControls({
  locationId,
  weekStartISO,
  unpublishedCount,
  totalCount,
}: {
  locationId: string;
  weekStartISO: string;
  unpublishedCount: number;
  totalCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const run = (published: boolean) => {
    startTransition(async () => {
      const result = await setWeekPublished(locationId, weekStartISO, published);
      setMessage(
        result.skipped > 0
          ? `${result.changed} shifts updated. ${result.skipped} left unchanged — inside the 48h edit cutoff.`
          : `${result.changed} shifts ${published ? "published" : "unpublished"}.`,
      );
      router.refresh();
    });
  };

  if (totalCount === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {message ? (
        <span className="text-xs text-[var(--text-muted)] max-w-xs">{message}</span>
      ) : null}

      {unpublishedCount > 0 ? (
        <button
          type="button"
          onClick={() => run(true)}
          disabled={pending}
          className="btn btn-primary text-xs"
        >
          Publish {unpublishedCount} draft{unpublishedCount === 1 ? "" : "s"}
        </button>
      ) : (
        <button type="button" onClick={() => run(false)} disabled={pending} className="btn text-xs">
          Unpublish week
        </button>
      )}
    </div>
  );
}
