"use client";

import { useEffect, useRef, useState } from "react";

/** IntersectionObserver includes clipping by the dashboard's scrolling list, not just the viewport.
 * Keep observing after the first load so history polling stops when a card leaves view. */
export function useVisibility(lazy: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);
  useEffect(() => {
    if (!lazy || !ref.current) return;
    const element = ref.current;
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.01 });
      observer.observe(element);
      return () => observer.disconnect();
    }
    // Older browsers still load only cards actually in view, including clipping by scroll ancestors.
    const check = () => {
      const rect = element.getBoundingClientRect();
      let top = 0, left = 0, bottom = window.innerHeight, right = window.innerWidth;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      }
      setVisible(rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
    };
    check();
    window.addEventListener("scroll", check, true);
    window.addEventListener("resize", check);
    return () => { window.removeEventListener("scroll", check, true); window.removeEventListener("resize", check); };
  }, [lazy]);
  return { ref, visible };
}
