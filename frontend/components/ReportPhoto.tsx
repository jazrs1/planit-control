"use client";

import { useState } from "react";

export default function ReportPhoto({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <div className={`flex items-center justify-center rounded-card bg-bg p-2 text-center text-sm text-muted ${className}`}>Photo preview unavailable</div>
    : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`rounded-card object-cover ${className}`} />;
}
