// The flood card's lead value: our next-24 h rain forecast, cross-checked against the NWS forecast.
// Same rule as the briefing (backend/briefing/inputs.py rain_disagreement): the two disagree when they
// are more than 2x apart and more than 1 in apart. Then neither is shown as fact; the card shows the range.

const DISAGREE_RATIO = 2;
const DISAGREE_IN = 1;

const inches = (v: number) => `${v.toFixed(1)} in`;

export type RainForecast = {
  /** The big value: "8.0 in", or the range "0.9–6.5 in" when the forecasts disagree. */
  value: string | null;
  caption: string;
  /** A small secondary line: "NWS: 7.1 in" when they agree. null when NWS is unavailable or disagrees. */
  note: string | null;
  disagree: boolean;
};

export function rainForecast(ours: number | null | undefined, nws: number | null | undefined): RainForecast {
  const ourValue = typeof ours === "number" && Number.isFinite(ours) ? ours : null;
  const nwsValue = typeof nws === "number" && Number.isFinite(nws) ? nws : null;
  // null: NWS unavailable, nothing extra.
  if (nwsValue === null) return { value: ourValue === null ? null : inches(ourValue), caption: "Rain expected, next 24 h", note: null, disagree: false };
  if (ourValue === null) return { value: null, caption: "Rain expected, next 24 h", note: `NWS: ${inches(nwsValue)}`, disagree: false };
  const [lo, hi] = [Math.min(ourValue, nwsValue), Math.max(ourValue, nwsValue)];
  if (hi > DISAGREE_RATIO * lo && hi - lo > DISAGREE_IN) {
    return { value: `${lo.toFixed(1)}–${inches(hi)}`, caption: "Forecasts disagree, rain next 24 h", note: null, disagree: true };
  }
  return { value: inches(ourValue), caption: "Rain expected, next 24 h", note: `NWS: ${inches(nwsValue)}`, disagree: false };
}
