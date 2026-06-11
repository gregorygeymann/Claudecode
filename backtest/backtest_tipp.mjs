#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 * BACKTEST MONTE-CARLO — WARRANTPRO v25 + MOTEUR TIPP
 *
 * Valide les 3 contraintes sur 1 an de trading simulé :
 *   1. Risque de ruine = 0%        (équité jamais ≤ 0, jamais sous le plancher)
 *   2. Max drawdown ≤ 45%          (cible structurelle 42% = plancher 58% HWM)
 *   3. Gain maximisé sous 1 et 2   (distribution des rendements à 1 an)
 *
 * Réutilise les fonctions EXACTES de production exportées par worker.js
 * (scanIndicators, detectSignal, computeSizing, blackScholes, tippRiskBudget).
 *
 * Usage :
 *   node backtest/backtest_tipp.mjs [nbRuns=200]
 *   node backtest/backtest_tipp.mjs 200 --torture   (gap catastrophe : toutes
 *                                                    les primes ouvertes → 0
 *                                                    un jour aléatoire)
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  scanIndicators, detectSignal, computeSizing, blackScholes,
  vixMultiplier, tippRiskBudget, RISK_CFG,
} from '../worker.js';

// ─── Paramètres de simulation ─────────────────────────────────────────────────
const NB_RUNS  = Math.max(10, Number(process.argv[2]) || 200);
const TORTURE  = process.argv.includes('--torture');
const NT       = 40;     // tickers simulés (univers liquide type SBF120/DAX)
const WARMUP   = 270;    // jours d'historique avant le 1er jour de trading
const DAYS     = 252;    // horizon : 1 an de bourse
const N        = WARMUP + DAYS;
const CAPITAL0 = 10000;
const SPREAD   = 0.015;  // 1.5% par côté (spread émetteur + slippage)
const GAP_P    = 0.002;  // prob./jour/position d'un gap violent (vente forcée à -70%)

// ─── RNG déterministe (mulberry32) ────────────────────────────────────────────
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

// ─── Génération des trajectoires (marché à régimes + jumps idiosyncratiques) ──
const MKT_REGIMES = [
  { vol: 0.13, drift: 0.09,  stay: 0.985, next: 1 }, // CALM
  { vol: 0.28, drift: -0.05, stay: 0.970, next: 0 }, // STRESS (10% → PANIC)
  { vol: 0.50, drift: -0.45, stay: 0.930, next: 1 }, // PANIC
];
function genPaths(rng) {
  const mret = new Float64Array(N);
  let reg = 0;
  for (let d = 0; d < N; d++) {
    const r = MKT_REGIMES[reg];
    mret[d] = r.drift / 252 + (r.vol / Math.sqrt(252)) * gauss(rng);
    const u = rng();
    if (u > r.stay) {
      if (reg === 1) reg = u > 1 - (1 - r.stay) * 0.33 ? 2 : 0;
      else reg = r.next;
    }
  }
  const prices = [];
  for (let t = 0; t < NT; t++) {
    const beta  = 0.6 + 0.8 * rng();
    const ivol  = (0.15 + 0.20 * rng()) / Math.sqrt(252);
    const p     = new Float64Array(N);
    let logP = Math.log(50 + 150 * rng());
    for (let d = 0; d < N; d++) {
      let r = beta * mret[d] + ivol * gauss(rng);
      const u = rng();
      if (u < 0.005)        r -= 0.05 + 0.15 * rng(); // choc baissier (setup CALL)
      else if (u > 0.997)   r += 0.04 + 0.08 * rng(); // choc haussier (setup PUT)
      logP += r;
      p[d] = Math.exp(logP);
    }
    prices.push(p);
  }
  return { mret, prices };
}

// ─── Indicateurs rapides (préfiltre + valorisation quotidienne) ───────────────
// Reproduit vol60/ret5/z du worker en O(n) ; la DÉCISION finale passe toujours
// par scanIndicators/detectSignal (code de production) sur les candidats.
function fastArrays(p) {
  const lr = new Float64Array(N);
  for (let i = 1; i < N; i++) lr[i] = Math.log(p[i] / p[i - 1]);
  const cs = new Float64Array(N + 1), cs2 = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { cs[i + 1] = cs[i] + lr[i]; cs2[i + 1] = cs2[i] + lr[i] * lr[i]; }
  const vol60 = new Float64Array(N), z = new Float64Array(N);
  for (let d = 60; d < N; d++) {
    const s = cs[d + 1] - cs[d + 1 - 60], s2 = cs2[d + 1] - cs2[d + 1 - 60];
    vol60[d] = Math.sqrt(Math.max(1e-9, (s2 / 60 - (s / 60) ** 2) * 252));
    if (d >= 65) {
      const ret5 = (p[d] - p[d - 5]) / p[d - 5];
      z[d] = ret5 / (vol60[d] / Math.sqrt(252) * Math.sqrt(5));
    }
  }
  return { vol60, z };
}
function mktFeatures(mret, d) {
  let s = 0, s2 = 0, r20 = 0;
  for (let i = d - 19; i <= d; i++) { s += mret[i]; s2 += mret[i] * mret[i]; r20 += mret[i]; }
  const sig20 = Math.sqrt(Math.max(0, (s2 / 20 - (s / 20) ** 2) * 252));
  return { sig20, ret20: r20 };
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

// ─── Simulation d'un run ──────────────────────────────────────────────────────
function simulate(seed, engineOn) {
  const rng = mulberry32(seed);
  const { mret, prices } = genPaths(rng);
  const fast = prices.map(fastArrays);

  let cash = CAPITAL0, equity = CAPITAL0, hwm = CAPITAL0, maxDD = 0, minEq = CAPITAL0;
  let riskState = null, floorBreach = 0, nTrades = 0, nWins = 0;
  const positions = [], cooldown = new Int32Array(NT);
  const tortureDay = TORTURE ? WARMUP + 30 + Math.floor(rng() * (DAYS - 60)) : -1;

  for (let d = WARMUP; d < N; d++) {
    // 1) Catastrophe (mode torture) : toutes les primes ouvertes → 0
    if (d === tortureDay) {
      positions.length = 0; // valeur perdue, aucun produit de vente
    }

    // 2) Sorties — règles exactes de recommendForPosition
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos  = positions[i];
      const S    = prices[pos.t][d];
      const sig  = Math.max(0.05, fast[pos.t].vol60[d]);
      const held = d - pos.entryDay;
      let w      = warrantValue(pos, S, sig, held);
      let forced = false;
      if (rng() < GAP_P) { w *= 0.30; forced = true; } // gap violent / spread émetteur explosé
      const sellPx = w * (1 - SPREAD);
      const wPnL   = (sellPx - pos.buyPrice) / pos.buyPrice;
      const uPnL   = (S - pos.S0) / pos.S0;
      const holdMax = pos.matuDays === 30 ? 10 : 14;
      const exit = forced
        || (wPnL >= 0.30 && held <= 5) || wPnL >= 0.25
        || (pos.dir === 'CALL' && (uPnL >= 0.03 || uPnL <= -0.05))
        || (pos.dir === 'PUT'  && (uPnL <= -0.03 || uPnL >= 0.05))
        || held >= holdMax
        || (pos.matuDays === 30 && pos.matuDays - held <= 7);
      if (exit) {
        cash += pos.qty * sellPx;
        nTrades++; if (wPnL > 0) nWins++;
        positions.splice(i, 1);
      }
    }

    // 3) Valorisation + budget TIPP
    let openValue = 0;
    for (const pos of positions) {
      const S = prices[pos.t][d], sig = Math.max(0.05, fast[pos.t].vol60[d]);
      openValue += pos.qty * warrantValue(pos, S, sig, d - pos.entryDay) * (1 - SPREAD);
    }
    equity = cash + openValue;

    let budget = null;
    if (engineOn) {
      budget = tippRiskBudget(equity, riskState);
      riskState = budget.state;
      // Règle d'allègement : primes ouvertes ≤ coussin, toujours
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

    // 4) Régime + VIX proxy (équivalent v22 simplifié)
    const mf = mktFeatures(mret, d);
    let kelly = 1.0, capMult = 1.0, zAdd = 0, allowEntry = true;
    if (mf.sig20 > 0.35 || mf.ret20 < -0.12) { kelly = 0; capMult = 0; allowEntry = false; }       // PANIC
    else if (mf.sig20 > 0.22 || mf.ret20 < -0.06) { kelly = 0.66; capMult = 0.66; zAdd = 0.5; }    // STRESS
    const vstoxx  = Math.max(10, mf.sig20 * 100 * 1.1);
    const vMult   = vixMultiplier(vstoxx, 'normal');
    const dailyCap = (vstoxx < 15 ? 0.50 : vstoxx < 20 ? 0.60 : vstoxx < 25 ? 0.70 : vstoxx < 30 ? 0.80 : 0.90) * capMult;
    let dailyUsed = 0;

    // 5) Entrées — préfiltre rapide puis code de production
    if (allowEntry && (!engineOn || budget.allowEntry)) {
      for (let t = 0; t < NT; t++) {
        if (cooldown[t] > d) continue;
        if (positions.some(p => p.t === t)) continue;
        const zf = fast[t].z[d];
        if (zf > -1.8 && zf < 2.7) continue;                       // préfiltre
        const ind = scanIndicators(barsSlice(prices[t], d, rng));  // PRODUCTION
        if (!ind) continue;
        const sig = detectSignal(ind);                             // PRODUCTION
        if (!sig) continue;
        if (zAdd > 0 && Math.abs(ind.z) < 2.5 + zAdd) continue;    // filtre régime STRESS

        const isFlash = ind.z < -3.0 && ind.rsi < 20 && ind.sqFresh;
        let szAdj = computeSizing(ind.z, ind.rsi, ind.sq, ind.ret63, isFlash, 'X', vMult) * kelly; // PRODUCTION
        szAdj = Math.min(0.25, szAdj);
        if (engineOn) szAdj *= budget.mult;
        if (szAdj <= 0) continue;

        let amount = equity * szAdj;
        amount = Math.min(amount, Math.max(0, equity * dailyCap - dailyUsed)); // cap quotidien
        if (engineOn) amount = Math.min(amount, Math.max(0, budget.cushion - openValue)); // budget TIPP
        amount = Math.min(amount, cash);
        if (amount < equity * 0.01) continue;

        const matuDays = Math.abs(ind.z) >= 2.5 ? 30 : 90;
        const S0 = ind.price, sigE = Math.max(0.05, ind.vol60 / 100);
        const dir = sig.dir;
        const w0  = (dir === 'CALL' ? blackScholes(S0, S0, matuDays / 365, sigE) : blackScholes(S0, S0, matuDays / 365, sigE)).price;
        if (w0 <= 0.001) continue;
        const buyPrice = w0 * (1 + SPREAD);
        const qty = amount / buyPrice;
        positions.push({ t, dir, K: S0, S0, entryDay: d, matuDays, buyPrice, qty });
        cash -= amount; openValue += amount; dailyUsed += amount;
        cooldown[t] = d + 7;
      }
    }

    // 6) Équité de clôture, DD, contrôles
    equity = cash;
    for (const pos of positions) {
      const S = prices[pos.t][d], sg = Math.max(0.05, fast[pos.t].vol60[d]);
      equity += pos.qty * warrantValue(pos, S, sg, d - pos.entryDay) * (1 - SPREAD);
    }
    if (equity > hwm) hwm = equity;
    const dd = 1 - equity / hwm;
    if (dd > maxDD) maxDD = dd;
    if (equity < minEq) minEq = equity;
    if (engineOn && riskState && equity < riskState.hwm * RISK_CFG.floorPct - 1e-6) floorBreach++;
  }

  return { ret: equity / CAPITAL0 - 1, maxDD, minEq, nTrades, winRate: nTrades ? nWins / nTrades : 0, floorBreach };
}

// ─── Agrégation & rapport ─────────────────────────────────────────────────────
function pct(x) { return (x * 100).toFixed(1) + '%'; }
function quantile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i];
}
function report(label, runs) {
  const rets = runs.map(r => r.ret), dds = runs.map(r => r.maxDD);
  const ruined = runs.filter(r => r.minEq <= 0).length;
  const over45 = runs.filter(r => r.maxDD > 0.45).length;
  const breaches = runs.reduce((s, r) => s + r.floorBreach, 0);
  console.log(`\n── ${label} ─────────────────────────────────────`);
  console.log(`  Rendement 1 an   : médiane ${pct(quantile(rets, 0.5))} · moyenne ${pct(rets.reduce((a, b) => a + b, 0) / rets.length)}`);
  console.log(`                     p5 ${pct(quantile(rets, 0.05))} · p95 ${pct(quantile(rets, 0.95))}`);
  console.log(`  Max drawdown     : médiane ${pct(quantile(dds, 0.5))} · pire ${pct(Math.max(...dds))}`);
  console.log(`  Runs avec DD>45% : ${over45}/${runs.length} (${pct(over45 / runs.length)})`);
  console.log(`  Ruine (équité≤0) : ${ruined}/${runs.length}`);
  console.log(`  Violations plancher TIPP : ${breaches}`);
  console.log(`  Trades/an médian : ${quantile(runs.map(r => r.nTrades), 0.5)} · win rate moyen ${pct(runs.reduce((s, r) => s + r.winRate, 0) / runs.length)}`);
  return { over45, ruined, breaches };
}

console.log(`Backtest Monte-Carlo WARRANTPRO v25 — ${NB_RUNS} runs × ${DAYS} jours × ${NT} tickers${TORTURE ? ' · MODE TORTURE (gap catastrophe)' : ''}`);
const t0 = Date.now();
const withEngine = [], withoutEngine = [];
for (let i = 0; i < NB_RUNS; i++) {
  withEngine.push(simulate(1000 + i, true));
  withoutEngine.push(simulate(1000 + i, false));
  if ((i + 1) % 50 === 0) console.log(`  ... ${i + 1}/${NB_RUNS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const off = report('SANS moteur TIPP (v22/v24 brut)', withoutEngine);
const on  = report('AVEC moteur TIPP (v25)', withEngine);

console.log('\n══ VERDICT ══════════════════════════════════════');
const ok = on.over45 === 0 && on.ruined === 0 && on.breaches === 0;
console.log(ok
  ? '✅ Contraintes respectées sur tous les runs : ruine 0%, MDD ≤ 45%, plancher jamais percé.'
  : `❌ ÉCHEC : DD>45% sur ${on.over45} runs, ruine ${on.ruined}, violations plancher ${on.breaches}.`);
process.exit(ok ? 0 : 1);
