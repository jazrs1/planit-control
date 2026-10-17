"""Evaluation metrics and probability calibration in plain numpy (no scikit-learn dependency)."""

import numpy as np


def average_precision(y, score) -> float:
    """PR-AUC as average precision (step-wise, ties grouped), matching scikit-learn's definition."""
    y = np.asarray(y, dtype=float)
    score = np.asarray(score, dtype=float)
    if y.sum() == 0:
        return float("nan")
    order = np.argsort(-score, kind="mergesort")
    y, score = y[order], score[order]
    last_of_tie = np.r_[np.diff(score) != 0, True]
    tp = np.cumsum(y)[last_of_tie]
    fp = np.cumsum(1 - y)[last_of_tie]
    precision = tp / (tp + fp)
    recall = tp / y.sum()
    return float(np.sum(np.diff(np.r_[0, recall]) * precision))


def roc_auc(y, score) -> float:
    """ROC-AUC via the rank-sum (Mann-Whitney) statistic, with average ranks for ties."""
    y = np.asarray(y, dtype=bool)
    n_pos, n_neg = y.sum(), (~y).sum()
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    _, inv, counts = np.unique(np.asarray(score, dtype=float), return_inverse=True, return_counts=True)
    ends = np.cumsum(counts)
    rank_of = ((ends - counts + 1 + ends) / 2)[inv]
    return float((rank_of[y].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def brier(y, p) -> float:
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def log_loss(y, p, eps: float = 1e-6) -> float:
    p = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    y = np.asarray(y, dtype=float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def reliability(y, p, edges) -> list[dict]:
    """Observed event rate per predicted-probability bin."""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, len(edges) - 2)
    out = []
    for b in range(len(edges) - 1):
        m = idx == b
        if m.sum() == 0:
            continue
        out.append({"lo": float(edges[b]), "hi": float(edges[b + 1]), "n": int(m.sum()),
                    "mean_pred": float(p[m].mean()), "observed": float(y[m].mean()), "events": int(y[m].sum())})
    return out


def block_bootstrap(groups, fn, n: int = 1000, seed: int = 0) -> np.ndarray:
    """Resample whole groups (e.g. dates, since one storm hits many sites at once) and apply fn(mask_idx)."""
    rng = np.random.default_rng(seed)
    groups = np.asarray(groups)
    uniq, inv = np.unique(groups, return_inverse=True)
    members = [np.flatnonzero(inv == g) for g in range(len(uniq))]
    out = []
    for _ in range(n):
        pick = rng.integers(0, len(uniq), len(uniq))
        out.append(fn(np.concatenate([members[g] for g in pick])))
    return np.asarray(out)


# ---------- calibration ----------

def _logit(p, eps: float = 1e-6):
    p = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    return np.log(p / (1 - p))


def fit_platt(raw_prob, y, iters: int = 100) -> tuple[float, float]:
    """Logistic recalibration p = sigmoid(a * logit(raw) + b), fit by Newton's method."""
    x = _logit(raw_prob)
    y = np.asarray(y, dtype=float)
    a, b = 1.0, 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(a * x + b)))
        w = p * (1 - p) + 1e-12
        g = np.array([np.sum((p - y) * x), np.sum(p - y)])
        h = np.array([[np.sum(w * x * x), np.sum(w * x)], [np.sum(w * x), np.sum(w)]])
        step = np.linalg.solve(h, g)
        a, b = a - step[0], b - step[1]
        if np.abs(step).max() < 1e-9:
            break
    return float(a), float(b)


def apply_platt(raw_prob, a: float, b: float) -> np.ndarray:
    return 1 / (1 + np.exp(-(a * _logit(raw_prob) + b)))


def fit_isotonic(raw_prob, y) -> tuple[np.ndarray, np.ndarray]:
    """Pool-adjacent-violators. Returns (x knots, y knots) for np.interp."""
    order = np.argsort(raw_prob)
    x = np.asarray(raw_prob, dtype=float)[order]
    yv = np.asarray(y, dtype=float)[order]
    vals, wts, xs = [], [], []
    for xi, yi in zip(x, yv):
        vals.append(yi); wts.append(1.0); xs.append([xi, xi])
        while len(vals) > 1 and vals[-2] >= vals[-1]:
            v = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / (wts[-2] + wts[-1])
            w = wts[-2] + wts[-1]
            span = [xs[-2][0], xs[-1][1]]
            vals[-2:], wts[-2:], xs[-2:] = [v], [w], [span]
    knots_x = np.array([(s[0] + s[1]) / 2 for s in xs])
    return knots_x, np.array(vals)
