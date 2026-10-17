"use client";

import { useState } from "react";

export default function ModelCalibrationPlot({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <p role="status" className="rounded-card border border-dashed border-border bg-bg p-4 text-sm text-muted">Model calibration plot unavailable.</p>
    : <img src={src} alt="Model calibration: predicted probability compared with the observed share of hazardous site-days. Points on the diagonal indicate matching probabilities." width={680} height={460} loading="lazy" onError={() => setFailed(true)} className="h-auto w-full rounded-card border-2 border-rule" />;
}
