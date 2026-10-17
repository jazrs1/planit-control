import type { ReactNode } from "react";

/** A small "i" button that opens a short explanation in a popover (native, no script). For help text
 *  that would otherwise sit in the main view. */
export default function InfoButton({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <>
    <button type="button" popoverTarget={id} aria-label={label} title={label}
      className="relative grid size-5 shrink-0 place-items-center rounded-pill border border-border-strong text-[0.6875rem] font-bold text-muted after:absolute after:-inset-3 after:content-[''] focus-visible:outline-2 active:scale-95 hover:text-text">
      i
    </button>
    <div id={id} popover="auto" className="pc-popover m-auto max-w-80 space-y-2 border border-border bg-surface p-4 text-start text-sm font-normal whitespace-normal text-text shadow-float">
      {children}
    </div>
  </>;
}
