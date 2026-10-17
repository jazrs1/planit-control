import type { ModelComparison, ModelInfo } from "@shared/types";
import ModelCalibrationPlot from "@/components/ModelCalibrationPlot";
import { modelCalibrationUrl } from "@/lib/api";

const count = (value: number) => value.toLocaleString("en-US");

function MetricsTable({ results, horizon, testYear }: { results: ModelComparison[]; horizon: "same_day" | "day_ahead"; testYear: ModelInfo["training"]["test_year"] }) {
  return <div className="overflow-x-auto">
    <table className="w-full text-start text-sm">
      <caption className="pbe-2 text-start text-xs text-muted">{testYear} test results · {horizon === "same_day" ? "same-day forecasts" : "forecasts issued a day earlier"}</caption>
      <thead className="border-be border-border text-xs text-muted">
        <tr><th scope="col" className="py-2 pe-3 font-normal">Method</th><th scope="col" className="px-3 py-2 text-end font-normal whitespace-nowrap">PR-AUC ↑</th><th scope="col" className="px-3 py-2 text-end font-normal whitespace-nowrap">ROC-AUC ↑</th><th scope="col" className="py-2 ps-3 text-end font-normal whitespace-nowrap">Brier ↓</th></tr>
      </thead>
      <tbody>
        {results.map((result, index) => {
          const metrics = result[horizon];
          return <tr key={result.name} className={index === 0 ? "font-semibold" : ""}>
            <th scope="row" className="py-2 pe-3 align-top font-semibold">{result.name}{horizon === "same_day" && <span className="mbs-1 block text-xs font-normal text-muted">{result.description}</span>}</th>
            <td className="px-3 py-2 text-end align-top tabular-nums">{metrics?.pr_auc.toFixed(4) ?? "—"}</td>
            <td className="px-3 py-2 text-end align-top tabular-nums">{metrics?.roc_auc.toFixed(4) ?? "—"}</td>
            <td className="py-2 ps-3 text-end align-top tabular-nums">{metrics?.brier.toFixed(5) ?? "—"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export default function ModelExplanation({ info }: { info: ModelInfo | null }) {
  const model = info?.results[0]; // Contract: model first, followed by baselines.
  const comparisons = info?.results.slice(1).filter((baseline) => baseline.same_day.pr_auc > 0);

  return <section id="model" aria-labelledby="ml-title" className="flex scroll-mt-4 flex-col gap-4 [&>p]:max-w-[68ch]">
    <h3 id="ml-title" className="text-xl font-semibold">Machine learning model</h3>
    <p>A model estimates the chance of a <strong className="font-semibold">crew-relevant hazardous weather day</strong>: NOAA Storm Events logs a storm, flood or other hazardous weather near the site. It mainly learns storms and floods; it does not predict injuries or the time of a lightning strike.</p>
    <p>It learns from <strong className="font-semibold">archived Open-Meteo forecasts matched against NOAA Storm Events</strong>, using the same kind of forecast it receives live.</p>

    {info === null ? <div role="status" className="rounded-card border border-dashed border-border-strong px-4 py-3 text-muted">
      <p className="font-semibold">Model details unavailable</p>
      <p>The server could not provide the model evaluation. Training years, test metrics and calibration are unavailable. Reload this page to try again.</p>
    </div> : <>
      <p><strong className="font-semibold">Trained on {info.training.train_years.join("–")}</strong> across {count(info.training.sites)} sites ({count(info.training.train_site_days)} site-days, {count(info.training.train_events)} reported hazardous days). Calibrated on {info.training.validation_year}; <strong className="font-semibold">tested on {info.training.test_year}</strong>, kept out of training and tuning.</p>

      <div className="space-y-2">
        <h4 className="font-semibold">Compared with two baselines</h4>
        {model && !!comparisons?.length && <p className="max-w-[68ch]">The model&apos;s same-day PR-AUC is {comparisons.map((baseline, index) => <span key={baseline.name}>{index > 0 && "; "}<strong className="font-semibold">{(model.same_day.pr_auc / baseline.same_day.pr_auc).toFixed(1)}×</strong> {baseline.name}</span>)}. This measures how well rare hazardous days rise to the top, not percent accuracy.</p>}
        <MetricsTable results={info.results} horizon="same_day" testYear={info.training.test_year} />
        <p className="text-xs text-muted">PR-AUC and ROC-AUC measure ranking; higher is better. Brier measures probability error; lower is better. Reported hazards occurred on {(info.test.base_rate * 100).toFixed(2)}% of test site-days ({count(info.test.events)} of {count(info.test.site_days)}).</p>
      </div>

      <details>
        <summary className="pc-link list-none">Day-ahead results and label definition</summary>
        <MetricsTable results={info.results} horizon="day_ahead" testYear={info.training.test_year} />
        <p className="mbs-2 text-xs text-muted">— = not evaluated. A site-day is one site on one local calendar day.</p>
        <p className="mbs-3 max-w-[68ch]"><strong className="font-semibold">Label: </strong>{info.label}</p>
        <p className="max-w-[68ch]"><strong className="font-semibold">Weather input: </strong>{info.weather_source}</p>
      </details>

      <figure className="space-y-2">
        <figcaption className="text-xs text-muted">Calibration: predicted chances versus reported events</figcaption>
        <ModelCalibrationPlot key={info.calibration.plot_url} src={modelCalibrationUrl(info.calibration.plot_url)} />
        <p className="max-w-[68ch] text-muted">The diagonal is a perfect match between predicted and observed chances. The model is better at ranking days than estimating exact probabilities; the highest probabilities can be overconfident.</p>
      </figure>
      <details>
        <summary className="pc-link list-none">Model evaluation limits</summary>
        <ul className="mbs-2 flex max-w-[68ch] list-disc flex-col gap-2 ps-5 text-muted">{info.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </details>
    </>}
  </section>;
}
