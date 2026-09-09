import { useEffect, useRef } from 'react';

// Shared dialog semantics for BLAXIN's overlay surfaces (settings, setup
// wizard, model details, confirmation gate). One hook keeps every dialog
// consistent:
//   - focus moves into the dialog on open (initialFocusRef first, else the
//     first focusable element, else the dialog container itself);
//   - Tab / Shift+Tab stay inside the dialog (focus trap);
//   - Escape invokes onClose when enabled (the confirmation gate uses its
//     own safe-default handler instead and disables this one);
//   - focus is restored to the previously-focused element on unmount.
// The component still owns role="dialog" / aria-modal / aria-labelledby.

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogA11y(
  containerRef: React.RefObject<HTMLElement | null>,
  {
    onClose,
    initialFocusRef,
    escapeCloses = true,
    enabled = true,
  }: {
    onClose?: () => void;
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    escapeCloses?: boolean;
    enabled?: boolean;
  } = {},
): void {
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    restoreRef.current = document.activeElement;

    // Initial focus: explicit target > first focusable > the container
    // (needs tabIndex={-1} to be programmatically focusable).
    const target =
      initialFocusRef?.current ??
      container.querySelector<HTMLElement>(FOCUSABLE) ??
      container;
    target.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeCloses && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: keep Tab / Shift+Tab cycling inside the dialog.
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const prev = restoreRef.current;
      restoreRef.current = null;
      if (prev instanceof HTMLElement) prev.focus();
    };
    // Dialogs mount/unmount to open/close — run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
