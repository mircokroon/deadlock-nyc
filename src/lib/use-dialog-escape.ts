import * as React from "react";

/**
 * Close a custom (non-Radix) dialog when Escape is pressed. No-op while the
 * dialog is closed, so it's safe to call unconditionally at the top of a
 * component that early-returns when `open` is false.
 */
export function useDialogEscape(open: boolean, onClose: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}
