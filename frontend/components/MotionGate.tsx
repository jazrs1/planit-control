"use client";

import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

// How long after a page loads its first-load entrance may run (see .pc-enter in globals.css).
const SETTLE_MS = 2500;

/** Marks each page "settled" shortly after it loads, so polling refreshes never replay the entrance. */
export default function MotionGate() {
  const pathname = usePathname();
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-settled");
    const timer = window.setTimeout(() => root.setAttribute("data-settled", ""), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  return null;
}
