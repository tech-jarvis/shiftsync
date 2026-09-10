"use client";

import { useEffect, useRef } from "react";

/**
 * Keyboard and focus behaviour for a drawer or modal dialog.
 *
 * Four things people expect from any overlay, none of which come for free:
 *
 *   Escape closes it.            Otherwise the only way out is finding the X.
 *   Focus moves inside on open.  Otherwise a keyboard user is still tabbing
 *                                through the schedule behind the panel.
 *   Focus is trapped while open. Same reason.
 *   Focus returns on close.      Otherwise it snaps to the top of the document
 *                                and the manager loses their place in the week.
 *
 * Also sets a flag on <body> so CSS can stop the page behind from scrolling --
 * without it a trackpad flick moves the schedule out from under the panel.
 *
 * Returns a ref to attach to the overlay's container element.
 */
export function useOverlay(onClose: () => void) {
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    document.body.dataset.overlayOpen = "true";

    const focusable = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // Focus the first control rather than the container itself, so the first
    // Tab goes somewhere sensible.
    const first = focusable()[0];
    if (first) first.focus();
    else container?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) return;

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped entirely.
      if (event.shiftKey && (active === firstItem || !container?.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      delete document.body.dataset.overlayOpen;
      // Only restore focus if it is still somewhere in the (now closing)
      // overlay -- if the user has clicked elsewhere, leave them be.
      if (previouslyFocused?.isConnected && container?.contains(document.activeElement)) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);

  return containerRef;
}
