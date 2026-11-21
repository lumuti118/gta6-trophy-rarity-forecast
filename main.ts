// GTA VI trophy rarity forecaster — refresh-aware earners/players model.
//
// Forecasts, for every trophy, five quantiles of its Exophase earn rate at
// the case target, on the logit scale.
//
// Model in brief:
//   * Decompose each rate into earners E and players tracked N (rate = E/N).
//   * Exophase refreshes on its own schedule: a refresh jumps N up and
//     DILUTES every rate. Detect jumps (N up >5% between reads) and fit
//     growth only on reads after the last jump, so stale pre-refresh reads
//     do not drag the forecast.
//   * Fit log E and log N against log(1 + hours since first read) (power-law
//     growth), project both to the target, median = 100 * E(tt) / N(tt).
//   * Spread on the logit scale combines fit residuals, expected refreshes
//     before the target, and horizon length.
//   * STALE-PAGE PRIOR: if the whole history is frozen (identical N and
//     rates on every read) and the horizon is over an hour, a refresh is
//     due during launch week, so shift every median down 15% and widen the
//     spread. A frozen page is not a stable page — it is a page about to
//     refresh and dilute.
//
// Stdlib only (node:fs, node:path). No network, no randomness, no clock:
// two runs on the same case write byte-identical output.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function logit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(l: number): number {
  return 100 / (1 + Math.exp(-l));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Ordinary least squares of y on x. Returns { slope, intercept, residStd }.
function ols(xs: number[], ys: number[]): { slope: number; intercept: number; residStd: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0, residStd: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0], residStd: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  const residStd = n > 2 ? Math.sqrt(rss / (n - 2)) : 0;
  return { slope, intercept, residStd };
}

interface TrophyDef {
  id: number;
  tier: string;
}

interface Read {
  atMs: number;
  n: number;
  rates: (number | null)[];
}

interface CaseData {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  trophies: TrophyDef[];
  history: Read[];
}

function parseCase(raw: string): CaseData {
  const c = JSON.parse(raw);
  const history: Read[] = (Array.isArray(c.history) ? c.history : []).map((h: any) => ({
    atMs: Date.parse(h.at),
    n: typeof h.players_tracked === "number" ? h.players_tracked : 0,
    rates: Array.isArray(h.rates) ? h.rates : [],
  }));
  return {
    id: String(c.id),
    at: String(c.at),
    horizon_minutes: typeof c.horizon_minutes === "number" ? c.horizon_minutes : 0,
    target: String(c.target),
    trophies: (Array.isArray(c.trophies) ? c.trophies : []).map((t: any) => ({
      id: typeof t.id === "number" ? t.id : 0,
      tier: typeof t.tier === "string" ? t.tier : "bronze",
    })),
    history,
  };
}

function forecast(c: CaseData): { id: number; q: number[] }[] {
  const trophies = c.trophies;
  const nT = trophies.length;
  const tc = Date.parse(c.at);
  const tt = Date.parse(c.target);
  const t0 = c.history.length > 0 ? c.history[0].atMs : tc;
  const hHours = Number.isFinite(tt - tc) && tt > tc ? (tt - tc) / 3600000 : c.horizon_minutes / 60;
  const hDays = hHours / 24;

  // No history at all: flat uninformative forecast.
  if (c.history.length === 0 || nT === 0) {
    return trophies.map((t) => ({ id: t.id, q: quantiles(1.0, 1.0) })).sort((a, b) => a.id - b.id);
  }

  const reads = c.history;
  const lastRead = reads[reads.length - 1];
  const lastN = lastRead.n > 0 ? lastRead.n : 1;

  // --- Refresh detection: N jumps >5% between consecutive reads. ---
  const jumpIdx: number[] = [];
  for (let j = 1; j < reads.length; j++) {
    if (reads[j - 1].n > 0 && reads[j].n > 1.05 * reads[j - 1].n) jumpIdx.push(j);
  }
  const lastJump = jumpIdx.length > 0 ? jumpIdx[jumpIdx.length - 1] : -1;
  // Reads after the last jump (inclusive of the jump read itself).
  const postJump = lastJump >= 0 ? reads.slice(lastJump) : reads;
  const fitReads = postJump.length >= 3 ? postJump : reads;

  // Median interval between jumps, in hours (for expected refresh count).
  let medianJumpIntervalH = 0;
  if (jumpIdx.length >= 2) {
    const gaps: number[] = [];
    for (let k = 1; k < jumpIdx.length; k++) {
      gaps.push((reads[jumpIdx[k]].atMs - reads[jumpIdx[k - 1]].atMs) / 3600000);
    }
    medianJumpIntervalH = median(gaps);
  } else if (jumpIdx.length === 1) {
    medianJumpIntervalH = (tc - reads[jumpIdx[0]].atMs) / 3600000;
  }

  const xOf = (atMs: number): number => Math.log(1 + Math.max(0, (atMs - t0) / 3600000));
  const xTarget = Math.log(1 + Math.max(0, (tt - t0) / 3600000));

  // --- Players N(tt): log-N power-law fit, conservative vs recent rate. ---
  let nTarget = lastN;
  {
    const xs = fitReads.map((r) => xOf(r.atMs));
    const ys = fitReads.map((r) => Math.log(Math.max(1, r.n)));
    const fit = ols(xs, ys);
    if (fit.slope > 0) {
      let proj = Math.exp(fit.intercept + fit.slope * xTarget);
      // Recent exponential rate over the last 12h; take the smaller projection.
      const recent = reads.filter((r) => r.atMs >= tc - 12 * 3600000);
      if (recent.length >= 2) {
        const rxs = recent.map((r) => (r.atMs - tc) / 3600000);
        const rys = recent.map((r) => Math.log(Math.max(1, r.n)));
        const rfit = ols(rxs, rys);
        if (rfit.slope > 0) {
          const projRecent = lastN * Math.exp(rfit.slope * hHours);
          if (projRecent < proj) proj = projRecent;
        }
      }
      // Cap implied growth at 2x per day, floor at last N.
      const cap = lastN * Math.pow(2, Math.max(0, hDays));
      nTarget = clamp(proj, lastN, cap);
    }
  }

  // --- Per-trophy earner fits. ---
  // E[i][j] for each trophy i and read j (null where rate missing or N<=0).
  const earners: (number | null)[][] = trophies.map((_, i) =>
    reads.map((r) => {
      const rate = r.rates[i];
      if (typeof rate !== "number" || r.n <= 0) return null;
      return (rate * r.n) / 100;
    }),
  );
  const lastE: (number | null)[] = earners.map((col) => {
    for (let j = col.length - 1; j >= 0; j--) if (col[j] !== null) return col[j];
    return null;
  });
  const lastRate: (number | null)[] = trophies.map((_, i) => {
    const rate = lastRead.rates[i];
    return typeof rate === "number" ? rate : null;
  });

  // Raw per-trophy log-E slopes (fit reads, fallback all reads).
  const rawSlope: number[] = [];
  const rawResid: number[] = [];
  const validCount: number[] = [];
  for (let i = 0; i < nT; i++) {
    const useReads = fitReads.length >= 3 ? fitReads : reads;
    const idxs = useReads.map((r) => reads.indexOf(r));
    const xs: number[] = [];
    const ys: number[] = [];
    for (const j of idxs) {
      const e = earners[i][j];
      if (e !== null && e > 0) {
        xs.push(xOf(reads[j].atMs));
        ys.push(Math.log(e));
      }
    }
    validCount.push(xs.length);
    if (xs.length >= 2) {
      const fit = ols(xs, ys);
      rawSlope.push(fit.slope);
      rawResid.push(fit.residStd);
    } else {
      rawSlope.push(0);
      rawResid.push(0);
    }
  }

  // Tier-median slopes (gold median is also the platinum reference).
  const tierOf = (i: number): string => trophies[i].tier;
  const tierMedianSlope = new Map<string, number>();
  const tierMedianResid = new Map<string, number>();
  for (const tier of ["platinum", "gold", "silver", "bronze"]) {
    const ss: number[] = [];
    const rs: number[] = [];
    for (let i = 0; i < nT; i++) {
      if (tierOf(i) === tier && validCount[i] >= 3) {
        ss.push(rawSlope[i]);
        rs.push(rawResid[i]);
      }
    }
    tierMedianSlope.set(tier, ss.length > 0 ? median(ss) : 0);
    tierMedianResid.set(tier, rs.length > 0 ? median(rs) : 0.15);
  }
  const goldMedianSlope = tierMedianSlope.get("gold") ?? 0;

  const sigmaRefresh = 0.3 * Math.sqrt(medianJumpIntervalH > 0 ? hHours / medianJumpIntervalH : 1.0);
  const sigmaHorizon = 0.12 * Math.sqrt(Math.max(0, hDays));

  // Stale-page check: every read identical in N and in rates.
  let frozen = reads.length > 0;
  for (let j = 1; j < reads.length && frozen; j++) {
    if (reads[j].n !== reads[0].n) frozen = false;
    else {
      for (let i = 0; i < nT; i++) {
        if (reads[j].rates[i] !== reads[0].rates[i]) {
          frozen = false;
          break;
        }
      }
    }
  }
  const stalePrior = frozen && hHours * 60 > 60;

  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < nT; i++) {
    const tier = tierOf(i);
    let med: number;
    let sigma: number;

    if (reads.length < 3) {
      // Fallback: persistence median + house-baseline spread.
      med = lastRate[i] !== null ? (lastRate[i] as number) : 1.0;
      sigma = Math.max(0.1, 0.5 * Math.sqrt(Math.max(0, hDays)));
    } else if (lastE[i] === null) {
      med = 1.0;
      sigma = 1.0;
    } else {
      // Shrink slope toward the tier median, weighted by valid-read count.
      const n = validCount[i];
      const tierMed = tierMedianSlope.get(tier) ?? 0;
      let slope = (n * rawSlope[i] + 2 * tierMed) / (n + 2);
      if (tier === "platinum") {
        slope = Math.min(slope, goldMedianSlope) * 0.5;
      }
      // Project earners from the last observed E along the shrunk slope.
      const xLast = xOf(reads[reads.length - 1].atMs);
      let eTarget = (lastE[i] as number) * Math.exp(slope * Math.max(0, xTarget - xLast));
      eTarget = clamp(eTarget, lastE[i] as number, 0.995 * nTarget);
      med = clamp((100 * eTarget) / nTarget, 0.01, 99.99);
      if (tier === "platinum") med = Math.min(med, 2);

      // Spread: fit residual (shrunk toward tier median), refresh, horizon.
      const tierResid = tierMedianResid.get(tier) ?? 0.15;
      let sigmaFit = (n * rawResid[i] + 2 * tierResid) / (n + 2);
      sigmaFit = clamp(sigmaFit, 0.05, 0.6);
      sigma = Math.sqrt(sigmaFit * sigmaFit + sigmaRefresh * sigmaRefresh + sigmaHorizon * sigmaHorizon);
      sigma = clamp(sigma, 0.1, 1.2);
      if (tier === "platinum") sigma = Math.max(sigma, 0.5);
    }

    // Stale-page prior (see header): a page frozen for hours during launch
    // week is about to refresh and dilute, so pull medians down and widen.
    if (stalePrior) {
      med = clamp(med * 0.85, 0.01, 99.99);
      sigma = clamp(sigma + 0.35, 0.1, 1.2);
    }

    rows.push({ id: trophies[i].id, q: quantiles(med, sigma) });
  }

  rows.sort((a, b) => a.id - b.id);
  return rows;
}

function quantiles(med: number, sigma: number): number[] {
  const base = logit(med);
  const out: number[] = [];
  let prev = -Infinity;
  for (const z of Z) {
    let q = Math.round(invLogit(base + z * sigma) * 10000) / 10000;
    q = clamp(q, 0.01, 99.99);
    if (q < prev) q = prev;
    out.push(q);
    prev = q;
  }
  return out;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outputDir, { recursive: true });
  const names = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const name of names) {
    const raw = readFileSync(join(inputDir, name), "utf8");
    const c = parseCase(raw);
    const rows = forecast(c);
    const outName = name.replace(/\.in$/, "") + ".out";
    writeFileSync(join(outputDir, outName), JSON.stringify({ trophies: rows }), "utf8");
  }
}

main();
