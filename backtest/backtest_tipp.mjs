#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 * BACKTEST MONTE-CARLO — WARRANTPRO v26 (double sleeve MR + MOMO) + MOTEUR TIPP
 *
 * Contraintes validées : ruine 0% (plancher TIPP 58% HWM), MDD ≤ 45%.
 * Objectif v26 : maximiser le gain sous ces contraintes en couplant :
 *   - sleeve MR   : mean-reversion v22 (PF≈2.0), TP fixe (snap-back)
 *   - sleeve MOMO : pullback en tendance, sizing inverse-vol (Moreira-Muir),
 *                   stop suiveur (laisser courir les gagnants)
 *   - DEPLOY      : déploiement plus complet du coussin TIPP quand il est inutilisé
 *
 * Le générateur inclut les deux anomalies documentées que ces sleeves exploitent
 * (réversion partielle post-choc idiosyncratique ; tendances persistantes AR(1)).
 * Il sert à comparer les variantes À GÉNÉRATEUR CONSTANT et à prouver la
 * mécanique de risque — pas à prédire la rentabilité absolue.
 *
 * Usage :
 *   node backtest/backtest_tipp.mjs [nbRuns=200]            → v25 vs v26 (+ sans moteur)
 *   node backtest/backtest_tipp.mjs [nbRuns] --variants     → ablation complète
 *   node backtest/backtest_tipp.mjs [nbRuns] --torture      → gap catastrophe (primes → 0)
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  scanIndicators, detectSignal, computeSizing, blackScholes,
  vixMultiplier, tippRiskBudget, RISK_CFG, TRAIL_CFG,
} from '../worker.js';

// ─── Paramètres ───────────────────────────────────────────────────────────────
const NB_RUNS  = Math.max(10, Number(process.argv[2]) || 200);
const TORTURE  = process.argv.includes('--torture');
const VARIANTS = process.argv.includes('--variants');
const NT       = 40;
const WARMUP   = 270;
const DAYS     = 252;
const N        = WARMUP + DAYS;
const CAPITAL0 = 10000;
const SPREAD   = 0.015;
const GAP_P    = 0.002;

const STRATS = {
  'v25 (MR seul)':         { momo: false, deploy: false, trailMR: false },
  'trailMR 20/50':         { momo: false, deploy: false, trailMR: true, trailTrig: TRAIL_CFG.trigger, trailKeep: TRAIL_CFG.keep },
  'DEPLOY seul':           { momo: false, deploy: true,  trailMR: false },
  'MOMO (rejeté)':         { momo: true,  deploy: false, trailMR: false },
  'v26 (trailMR+DEPLOY)':  { momo: false, deploy: true,  trailMR: true, trailTrig: TRAIL_CFG.trigger, trailKeep: TRAIL_CFG.keep },
};

// ─── RNG déterministe ─────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Génération des trajectoires ──────────────────────────────────────────────
// Marché à régimes + deux anomalies documentées :
//  - réversion partielle post-choc (Jegadeesh 1990, short-term reversal) :
//    60% des chocs baissiers retracent ~40% sur 8 jours
//  - tendance idiosyncratique persistante AR(1) φ=0.99 (Jegadeesh & Titman 1993)
const MKT_REGIMES = [
  { vol: 0.13, drift: 0.09,  stay: 0.985, next: 1 },
  { vol: 0.28, drift: -0.05, stay: 0.970, next: 0 },
  { vol: 0.50, drift: -0.45, stay: 0.930, next: 1 },
];
function genPaths(rng) {
  const mret = new Float64Array(N);
  let reg = 0;
  for (let d = 0; d < N; d++) {
    const r = MKT_REGIMES[reg];
    mret[d] = r.drift / 252 + (r.vol / Math.sqrt(252)) * gauss(rng);
    const u = rng();
    if (u > r.stay) reg = (reg === 1 && u > 1 - (1 - r.stay) * 0.33) ? 2 : MKT_REGIMES[reg].next;
  }
  const prices = [];
  for (let t = 0; t < NT; t++) {
    const beta  = 0.6 + 0.8 * rng();
    const ivol  = (0.15 + 0.20 * rng()) / Math.sqrt(252);
    const p     = new Float64Array(N);
    const rev   = new Float64Array(N + 12);          // réversion post-choc programmée
    let logP = Math.log(50 + 150 * rng());
    let trend = 0;
    const trendShock = 0.00011;                       // σ stationnaire ≈ ±20%/an
    for (let d = 0; d < N; d++) {
      trend = 0.99 * trend + trendShock * gauss(rng);
      let r = beta * mret[d] + trend + ivol * gauss(rng) + rev[d];
      const u = rng();
      if (u < 0.005) {
        const jump = -(0.05 + 0.15 * rng());
        r += jump;
        if (rng() < 0.60) {                           // sur-réaction : retracement 40% / 8j
          const back = -jump * 0.40 / 8;
          for (let k = 1; k <= 8; k++) rev[d + k] += back;
        }
      } else if (u > 0.997) {
        r += 0.04 + 0.08 * rng();
      }
      logP += r;
      p[d] = Math.exp(logP);
    }
    prices.push(p);
  }
  return { mret, prices };
}

// ─── Indicateurs rapides (préfiltres + valorisation) ──────────────────────────
function fastArrays(p) {
  const lr = new Float64Array(N);
  for (let i = 1; i < N; i++) lr[i] = Math.log(p[i] / p[i - 1]);
  const cs = new Float64Array(N + 1), cs2 = new Float64Array(N + 1), cp = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    cs[i + 1] = cs[i] + lr[i]; cs2[i + 1] = cs2[i] + lr[i] * lr[i]; cp[i + 1] = cp[i] + p[i];
  }
  const vol60 = new Float64Array(N), z = new Float64Array(N), ret63 = new Float64Array(N),
        ret126 = new Float64Array(N), mm200 = new Float64Array(N);
  for (let d = 60; d < N; d++) {
    const s = cs[d + 1] - cs[d + 1 - 60], s2 = cs2[d + 1] - cs2[d + 1 - 60];
    vol60[d] = Math.sqrt(Math.max(1e-9, (s2 / 60 - (s / 60) ** 2) * 252));
    if (d >= 65) {
      const r5 = (p[d] - p[d - 5]) / p[d - 5];
      z[d] = r5 / (vol60[d] / Math.sqrt(252) * Math.sqrt(5));
    }
    if (d >= 63)  ret63[d]  = (p[d] - p[d - 63]) / p[d - 63];
    if (d >= 126) ret126[d] = (p[d] - p[d - 126]) / p[d - 126];
    if (d >= 199) mm200[d] = (cp[d + 1] - cp[d + 1 - 200]) / 200;
  }
  return { vol60, z, ret63, ret126, mm200 };
}
function mktFeatures(mret, d) {
  let s = 0, s2 = 0;
  for (let i = d - 19; i <= d; i++) { s += mret[i]; s2 += mret[i] * mret[i]; }
  return { sig20: Math.sqrt(Math.max(0, (s2 / 20 - (s / 20) ** 2) * 252)), ret20: s };
}
function barsSlice(p, d, rng) {
  const from = Math.max(0, d - 269), out = [];
  for (let i = from; i <= d; i++) out.push({ c: p[i], v: 1e5 * (0.5 + rng()) });
  return out;
}
function warrantValue(pos, S, sig, held) {
  const T = Math.max((pos.matuDays - held) / 365, 0.001);
  const bs = pos.dir === 'CALL' ? blackScholes(S, pos.K, T, sig) : blackScholes(pos.K, S, T, sig);
  return Math.max(0.001, bs.price);
}

// ─── Signal MOMO (portable worker : n'utilise que les sorties de scanIndicators)
// Warrant ITM (strike 88% du spot) : théta minimal, delta ~0.8 — adapté au
// directionnel en tendance. Stops larges suiveurs sur le sous-jacent.
// TSMOM (Moskowitz-Ooi-Pedersen) : lookback long 126j pour filtrer le bruit,
// entrée sur force (pas de pullback), stops larges, échéance 6 mois.
const MOMO_CFG = {
  strikeRatio: 0.85,  // ITM 15%
  matuDays:    180,   // 6 mois
  slInit:      0.90,  // stop initial : S < 90% du S0
  trail:       0.90,  // stop suiveur : S < 90% du plus-haut atteint
  holdMax:     60,
  thetaMin:    30,    // sortie si ≤ 30 jours restants
  maxOpen:     3,
  cooldown:    20,
  ret126Min:   0.20,  // tendance 6 mois > +20%
  ret63Min:    8,     // tendance 3 mois > +8% (en %, format scanIndicators)
};
function detectMomoSignal(a, ret126) {
  if (!a) return null;
  if (ret126 > MOMO_CFG.ret126Min && a.ret63 > MOMO_CFG.ret63Min && a.aboveMM200 === true
      && a.z > -1.0 && a.rsi >= 45 && a.rsi <= 70 && a.gapRisk !== 'high') {
    return { dir: 'CALL', conf: 'M', strat: 'MOMO' };
  }
  return null;
}

// ─── Simulation d'un run ──────────────────────────────────────────────────────
function simulate(seed, engineOn, strat) {
  const rng = mulberry32(seed);
  const { mret, prices } = genPaths(rng);
  const fast = prices.map(fastArrays);

  let cash = CAPITAL0, equity = CAPITAL0, hwm = CAPITAL0, maxDD = 0, minEq = CAPITAL0;
  let riskState = null, floorBreach = 0, nTrades = 0, nWins = 0;
  let pnlMR = 0, pnlMomo = 0;
  const positions = [], cooldown = new Int32Array(NT);
  const tortureDay = TORTURE ? WARMUP + 30 + Math.floor(rng() * (DAYS - 60)) : -1;

  for (let d = WARMUP; d < N; d++) {
    if (d === tortureDay) positions.length = 0;     // catastrophe : primes → 0

    // 1) Sorties
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos  = positions[i];
      const S    = prices[pos.t][d];
      const sig  = Math.max(0.05, fast[pos.t].vol60[d]);
      const held = d - pos.entryDay;
      let w      = warrantValue(pos, S, sig, held);
      let forced = false;
      if (rng() < GAP_P) { w *= 0.30; forced = true; }
      const sellPx = w * (1 - SPREAD);
      if (sellPx > pos.peakSell) pos.peakSell = sellPx;
      const wPnL = (sellPx - pos.buyPrice) / pos.buyPrice;
      const uPnL = (S - pos.S0) / pos.S0;

      let exit = forced;
      if (!exit && pos.sleeve === 'MOMO') {
        if (S > pos.peakS) pos.peakS = S;
        exit = S < pos.S0 * MOMO_CFG.slInit                               // stop initial
          || S < pos.peakS * MOMO_CFG.trail                               // stop suiveur sous-jacent
          || held >= MOMO_CFG.holdMax
          || pos.matuDays - held <= MOMO_CFG.thetaMin;
      } else if (!exit) {                                                 // MR
        const holdMax = pos.matuDays === 30 ? 10 : 14;
        if (strat.trailMR) {
          // stop suiveur après +trailTrig au lieu du TP fixe (on garde trailKeep du pic)
          const peakGain = pos.peakSell - pos.buyPrice;
          exit = (peakGain >= strat.trailTrig * pos.buyPrice && sellPx <= pos.buyPrice + strat.trailKeep * peakGain)
            || (pos.dir === 'CALL' && uPnL <= -0.05) || (pos.dir === 'PUT' && uPnL >= 0.05)
            || held >= holdMax
            || (pos.matuDays === 30 && pos.matuDays - held <= 7);
        } else {                                                          // règles v22
          exit = (wPnL >= 0.30 && held <= 5) || wPnL >= 0.25
            || (pos.dir === 'CALL' && (uPnL >= 0.03 || uPnL <= -0.05))
            || (pos.dir === 'PUT'  && (uPnL <= -0.03 || uPnL >= 0.05))
            || held >= holdMax
            || (pos.matuDays === 30 && pos.matuDays - held <= 7);
        }
      }
      if (exit) {
        cash += pos.qty * sellPx;
        const pnl = pos.qty * (sellPx - pos.buyPrice);
        if (pos.sleeve === 'MOMO') pnlMomo += pnl; else pnlMR += pnl;
        nTrades++; if (wPnL > 0) nWins++;
        positions.splice(i, 1);
      }
    }

    // 2) Valorisation + budget TIPP + allègement
    let openValue = 0;
    for (const pos of positions) {
      const S = prices[pos.t][d];
      openValue += pos.qty * warrantValue(pos, S, Math.max(0.05, fast[pos.t].vol60[d]), d - pos.entryDay) * (1 - SPREAD);
    }
    equity = cash + openValue;
    let budget = null;
    if (engineOn) {
      budget = tippRiskBudget(equity, riskState);
      riskState = budget.state;
      while (openValue > budget.cushion && positions.length > 0) {
        let imax = 0, vmax = -1;
        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i], S = prices[pos.t][d];
          const v = pos.qty * warrantValue(pos, S, Math.max(0.05, fast[pos.t].vol60[d]), d - pos.entryDay) * (1 - SPREAD);
          if (v > vmax) { vmax = v; imax = i; }
        }
        cash += vmax; openValue -= vmax; nTrades++;
        positions.splice(imax, 1);
      }
      equity = cash + openValue;
    }

    // 3) Régime + VIX proxy
    const mf = mktFeatures(mret, d);
    let kelly = 1.0, capMult = 1.0, zAdd = 0, allowEntry = true;
    if (mf.sig20 > 0.35 || mf.ret20 < -0.12) { kelly = 0; capMult = 0; allowEntry = false; }
    else if (mf.sig20 > 0.22 || mf.ret20 < -0.06) { kelly = 0.66; capMult = 0.66; zAdd = 0.5; }
    const vstoxx   = Math.max(10, mf.sig20 * 100 * 1.1);
    const vMult    = vixMultiplier(vstoxx, 'normal');
    const dailyCap = (vstoxx < 15 ? 0.50 : vstoxx < 20 ? 0.60 : vstoxx < 25 ? 0.70 : vstoxx < 30 ? 0.80 : 0.90) * capMult;
    let dailyUsed  = 0;

    // DEPLOY : quand le budget TIPP est largement inutilisé et le DD faible,
    // on déploie davantage chaque signal — pondéré par la qualité du signal.
    const deployOn = strat.deploy && engineOn && budget && budget.dd < 0.15 && budget.cushion > 0;

    // 4) Entrées
    if (allowEntry && (!engineOn || budget.allowEntry)) {
      for (let t = 0; t < NT; t++) {
        if (cooldown[t] > d) continue;
        if (positions.some(p => p.t === t)) continue;
        const f = fast[t], zf = f.z[d];
        const candMR   = zf < -1.35 || zf > 2.4;   // couvre les paliers H/M/L + PUT
        const nMomoOpen = positions.reduce((s, p) => s + (p.sleeve === 'MOMO' ? 1 : 0), 0);
        const candMomo = strat.momo && nMomoOpen < MOMO_CFG.maxOpen
          && f.ret126[d] > MOMO_CFG.ret126Min && f.ret63[d] > MOMO_CFG.ret63Min / 100
          && f.mm200[d] > 0 && prices[t][d] > f.mm200[d] && zf > -1.1;
        if (!candMR && !candMomo) continue;

        const ind = scanIndicators(barsSlice(prices[t], d, rng));   // PRODUCTION
        if (!ind) continue;
        let sig = detectSignal(ind);                                 // PRODUCTION (MR)
        let sleeve = 'MR';
        if (sig && zAdd > 0 && Math.abs(ind.z) < 2.5 + zAdd) sig = null;
        if (!sig && candMomo) { sig = detectMomoSignal(ind, f.ret126[d]); if (sig) sleeve = 'MOMO'; }
        if (!sig) continue;

        const isFlash = sleeve === 'MR' && ind.z < -3.0 && ind.rsi < 20 && ind.sqFresh;
        let szAdj;
        if (sleeve === 'MOMO') {
          // Sizing inverse-volatilité (Moreira-Muir), pas de boost VIX
          szAdj = 0.08 * Math.min(1.4, Math.max(0.5, 20 / Math.max(5, ind.vol60))) * kelly * Math.min(1, vMult);
          szAdj = Math.min(0.12, szAdj);
        } else {
          szAdj = computeSizing(ind.z, ind.rsi, ind.sq, ind.ret63, isFlash, 'X', vMult) * kelly; // PRODUCTION
          szAdj = Math.min(0.25, szAdj);
        }
        if (deployOn) {
          const boost = Math.min(0.5, 0.6 * Math.max(0, 1 - openValue / budget.cushion));
          const w = (sig.conf === 'H' || isFlash) ? 1 : 0.6;   // pondéré par qualité
          szAdj *= 1 + boost * w;
        }
        if (engineOn) szAdj *= budget.mult;
        if (szAdj <= 0) continue;

        let amount = equity * szAdj;
        amount = Math.min(amount, Math.max(0, equity * dailyCap - dailyUsed));
        if (engineOn) amount = Math.min(amount, Math.max(0, budget.cushion - openValue));
        amount = Math.min(amount, cash);
        if (amount < equity * 0.01) continue;

        const matuDays = sleeve === 'MOMO' ? MOMO_CFG.matuDays : (Math.abs(ind.z) >= 2.5 ? 30 : 90);
        const S0 = ind.price, sigE = Math.max(0.05, ind.vol60 / 100);
        const K  = sleeve === 'MOMO' ? S0 * MOMO_CFG.strikeRatio : S0;   // MOMO : ITM 12%
        const w0 = blackScholes(S0, K, matuDays / 365, sigE).price;
        if (w0 <= 0.001) continue;
        const buyPrice = w0 * (1 + SPREAD);
        positions.push({ t, dir: sig.dir, K, S0, entryDay: d, matuDays, buyPrice, qty: amount / buyPrice, sleeve, peakSell: 0, peakS: S0 });
        cash -= amount; openValue += amount; dailyUsed += amount;
        cooldown[t] = d + (sleeve === 'MOMO' ? MOMO_CFG.cooldown : 7);
      }
    }

    // 5) Clôture : équité, DD, contrôles
    equity = cash;
    for (const pos of positions) {
      const S = prices[pos.t][d];
      equity += pos.qty * warrantValue(pos, S, Math.max(0.05, fast[pos.t].vol60[d]), d - pos.entryDay) * (1 - SPREAD);
    }
    if (equity > hwm) hwm = equity;
    const dd = 1 - equity / hwm;
    if (dd > maxDD) maxDD = dd;
    if (equity < minEq) minEq = equity;
    if (engineOn && riskState && equity < riskState.hwm * RISK_CFG.floorPct - 1e-6) floorBreach++;
  }

  return { ret: equity / CAPITAL0 - 1, maxDD, minEq, nTrades, winRate: nTrades ? nWins / nTrades : 0, floorBreach, pnlMR, pnlMomo };
}

// ─── Agrégation & rapport ─────────────────────────────────────────────────────
function pct(x) { return (x * 100).toFixed(1) + '%'; }
function quantile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}
function report(label, runs) {
  const rets = runs.map(r => r.ret), dds = runs.map(r => r.maxDD);
  const ruined = runs.filter(r => r.minEq <= 0).length;
  const over45 = runs.filter(r => r.maxDD > 0.45).length;
  const breaches = runs.reduce((s, r) => s + r.floorBreach, 0);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\n── ${label} ─────────────────────────────────────`);
  console.log(`  Rendement 1 an   : médiane ${pct(quantile(rets, 0.5))} · moyenne ${pct(mean(rets))} · p5 ${pct(quantile(rets, 0.05))} · p95 ${pct(quantile(rets, 0.95))}`);
  console.log(`  Max drawdown     : médiane ${pct(quantile(dds, 0.5))} · pire ${pct(Math.max(...dds))} · DD>45% : ${over45}/${runs.length}`);
  console.log(`  Ruine ${ruined} · violations plancher ${breaches} · trades/an méd. ${quantile(runs.map(r => r.nTrades), 0.5)} · win ${pct(mean(runs.map(r => r.winRate)))}`);
  console.log(`  PnL moyen/run    : MR ${mean(runs.map(r => r.pnlMR)).toFixed(0)}€ · MOMO ${mean(runs.map(r => r.pnlMomo)).toFixed(0)}€`);
  return { over45, ruined, breaches };
}

console.log(`Backtest Monte-Carlo WARRANTPRO v26 — ${NB_RUNS} runs × ${DAYS} j × ${NT} tickers${TORTURE ? ' · MODE TORTURE' : ''}`);
const t0 = Date.now();
const toRun = VARIANTS ? Object.entries(STRATS) : [['v25 (MR seul)', STRATS['v25 (MR seul)']], ['v26 (trailMR+DEPLOY)', STRATS['v26 (trailMR+DEPLOY)']]];
const results = toRun.map(() => []);
const offEngine = [];
for (let i = 0; i < NB_RUNS; i++) {
  for (let s = 0; s < toRun.length; s++) results[s].push(simulate(1000 + i, true, toRun[s][1]));
  offEngine.push(simulate(1000 + i, false, toRun[toRun.length - 1][1]));
  if ((i + 1) % 50 === 0) console.log(`  ... ${i + 1}/${NB_RUNS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
let finalCheck = null;
for (let s = 0; s < toRun.length; s++) finalCheck = report(`${toRun[s][0]} — moteur TIPP ON`, results[s]);
const off = report(`${toRun[toRun.length - 1][0]} — SANS moteur (référence)`, offEngine);

console.log('\n══ VERDICT ══════════════════════════════════════');
const ok = finalCheck.over45 === 0 && finalCheck.ruined === 0 && finalCheck.breaches === 0;
console.log(ok
  ? '✅ Contraintes respectées sur tous les runs : ruine 0%, MDD ≤ 45%, plancher jamais percé.'
  : `❌ ÉCHEC : DD>45% sur ${finalCheck.over45} runs, ruine ${finalCheck.ruined}, violations plancher ${finalCheck.breaches}.`);
process.exit(ok ? 0 : 1);
