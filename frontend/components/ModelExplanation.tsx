import type { ModelComparison, ModelInfo } from "@shared/types";
import ModelCalibrationPlot from "@/components/ModelCalibrationPlot";
import { modelCalibrationUrl } from "@/lib/api";

const count = (value: number) => value.toLocaleString("en-US");

function MetricsTable({ results, horizon, testYear }: { results: ModelComparison[]; horizon: "same_day" | "day_ahead"; testYear: ModelInfo["training"]["test_year"] }) {
  return <div className="overflow-x-auto rounded-card border border-border">
    <table className="w-full text-start text-sm">
      <caption className="p-3 text-start font-semibold">{testYear} test results · {horizon === "same_day" ? "same-day forecasts" : "forecasts issued a day earlier"}</caption>
      <thead className="border-y border-border bg-bg text-xs text-muted">
        <tr><th scope="col" className="p-3">Method</th><th scope="col" className="p-3 text-end whitespace-nowrap">PR-AUC ↑</th><th scope="col" className="p-3 text-end whitespace-nowrap">ROC-AUC ↑</th><th scope="col" className="p-3 text-end whitespace-nowrap">Brier ↓</th></tr>
      </thead>
      <tbody className="divide-y divide-border">
        {results.map((result, index) => {
          const metrics = result[horizon];
          return <tr key={result.name} className={index === 0 ? "bg-bg font-semibold" : ""}>
            <th scope="row" className="p-3 font-medium">{result.name}{horizon === "same_day" && <span className="mbs-1 block text-xs font-normal text-muted">{result.description}</span>}</th>
            <td className="p-3 text-end tabular-nums">{metrics?.pr_auc.toFixed(4) ?? "—"}</td>
            <td className="p-3 text-end tabular-nums">{metrics?.roc_auc.toFixed(4) ?? "—"}</td>
            <td className="p-3 text-end tabular-nums">{metrics?.brier.toFixed(5) ?? "—"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export default function ModelExplanation({ info }: { info: ModelInfo | null }) {
  const model = info?.results[0]; // Contract: model first, followed by baselines.
  const comparisons = info?.results.slice(1).filter((baseline) => baseline.same_day.pr_auc > 0);

  return <section id="model" aria-labelledby="ml-title" className="scroll-mt-4 space-y-4 rounded-card border border-border bg-surface p-4">
    <h3 id="ml-title" className="text-lg font-bold text-brand">Machine learning model</h3>
    <p>A model estimates the chance of a <strong>crew-relevant hazardous weather day</strong>: NOAA Storm Events logs a storm, flood or other hazardous weather near the site. It mainly learns storms and floods; it does not predict injuries or the time of a lightning strike.</p>
    <p>It learns from <strong>archived Open-Meteo forecasts matched against NOAA Storm Events</strong>, using the same kind of forecast it receives live.</p>

    {info === null ? <div role="status" className="rounded-card border border-dashed border-border bg-bg p-3 text-muted">
      <p className="font-semibold">Model details unavailable</p>
      <p className="text-sm">The server could not provide the model evaluation. Training years, test metrics and calibration are unavailable. Reload this page to try again.</p>
    </div> : <>
      <p><strong>Trained on {info.training.train_years.join("–")}</strong> across {count(info.training.sites)} sites ({count(info.training.train_site_days)} site-days, {count(info.training.train_events)} reported hazardous days). Calibrated on {info.training.validation_year}; <strong>tested on {info.training.test_year}</strong>, kept out of training and tuning.</p>

      <div className="space-y-2">
        <h4 className="font-bold">Compared with two baselines</h4>
        {model && !!comparisons?.length && <p className="text-sm">The model&apos;s same-day PR-AUC is {comparisons.map((baseline, index) => <span key={baseline.name}>{index > 0 && "; "}<strong>{(model.same_day.pr_auc / baseline.same_day.pr_auc).toFixed(1)}×</strong> {baseline.name}</span>)}. This measures how well rare hazardous days rise to the top, not percent accuracy.</p>}
        <MetricsTable results={info.results} horizon="same_day" testYear={info.training.test_year} />
        <p className="text-xs text-muted">PR-AUC and ROC-AUC measure ranking; higher is better. Brier measures probability error; lower is better. Reported hazards occurred on {(info.test.base_rate * 100).toFixed(2)}% of test site-days ({count(info.test.events)} of {count(info.test.site_days)}).</p>
      </div>

      <details className="rounded-card border border-border bg-bg p-3">
        <summary className="cursor-pointer font-semibold text-brand">Day-ahead results and label definition</summary>
        <MetricsTable results={info.results} horizon="day_ahead" testYear={info.training.test_year} />
        <p className="mbs-2 text-xs text-muted">— = not evaluated. A site-day is one site on one local calendar day.</p>
        <p className="mbs-3 text-sm"><strong>Label: </strong>{info.label}</p>
        <p className="text-sm"><strong>Weather input: </strong>{info.weather_source}</p>
      </details>

      <figure className="space-y-2">
        <figcaption className="font-semibold">Calibration: predicted chances versus reported events</figcaption>
        <ModelCalibrationPlot key={info.calibration.plot_url} src={modelCalibrationUrl(info.calibration.plot_url)} />
        <p className="text-sm text-muted">The diagonal is a perfect match between predicted and observed chances. The model is better at ranking days than estimating exact probabilities; the highest probabilities can be overconfident.</p>
      </figure>
      <details className="rounded-card border border-border bg-bg p-3">
        <summary className="cursor-pointer font-semibold text-brand">Model evaluation limits</summary>
        <ul className="mbs-2 list-disc space-y-2 ps-5 text-sm text-muted">{info.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </details>
    </>}
  </section>;
}
