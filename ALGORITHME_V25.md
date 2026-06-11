# WARRANTPRO v25 — Algorithme d'achat/vente de warrants avec garantie structurelle de risque

> **Objectifs imposés** : gain maximal sur 1 an · risque de ruine 0% · max drawdown ≤ 45%.
>
> **Réponse** : on ne peut pas *promettre* un gain (personne ne le peut), mais on peut
> **garantir mathématiquement** les deux contraintes de risque et maximiser le gain
> *sous ces contraintes*. C'est exactement ce que fait v25 : l'edge mean-reversion
> validé du worker (PF ≈ 2.0) enveloppé dans un moteur de risque **TIPP**
> (Time-Invariant Portfolio Protection, variante du CPPI à plancher cliqueté).

---

## 1. Pourquoi cette architecture (synthèse de la recherche)

Trois résultats convergent dans la littérature :

1. **La perte maximale d'un warrant classique = la prime payée** (pas d'appel de marge,
   contrairement aux CFD/futures). C'est la propriété clé qui rend une garantie de
   ruine 0% *possible* : il suffit de borner la somme des primes engagées.
2. **Kelly fractionné** : le Kelly plein maximise la croissance théorique mais produit
   des drawdowns de 50–80% ; le demi/quart-Kelly conserve ~75% de la croissance pour
   moitié moins de drawdown. Le sizing v22 existant (3–25% par signal, modulé VIX et
   régime) est déjà un Kelly fractionné — on le conserve.
3. **CPPI/TIPP** : la seule famille de méthodes qui *garantit* un plancher de capital
   par construction (et non statistiquement). La variante TIPP cliquète le plancher
   sur le plus-haut historique (high-water mark), ce qui transforme la garantie de
   capital en **garantie de max drawdown**.

## 2. L'algorithme complet

### Couche 1 — Signal (inchangée, edge validé PF ≈ 2.0)

- **CALL** : chute ≥ 2.5σ sur 5 jours + RSI(14) < 25 + squeeze de volatilité
  (vol5/vol21 < 0.8 récent) + |momentum 3 mois| < 15% (on n'achète pas un couteau
  qui tombe structurellement).
- **CALL modéré** : 2.0σ + RSI < 30 + squeeze confirmé.
- **PUT** : hausse ≥ 3.0σ + RSI > 75 + squeeze.
- Warrant **ATM**, échéance 1 mois si |z| ≥ 2.5σ, sinon 3 mois.
- Filtres : régime K-means (CALM/STRESS/PANIC) sur l'indice, multiplicateur VIX/VSTOXX,
  corrélation sectorielle, cap sectoriel 35%, cap quotidien 50–90% selon VIX,
  cooldown 7 jours par ticker.

### Couche 2 — Sorties (inchangées)

| Règle | Seuil |
|---|---|
| TP ultra | warrant +30% en ≤ 5 jours |
| TP warrant | +25% (alerte à +20%) |
| TP sous-jacent | ±3% (CALL/PUT) |
| **Stop-loss sous-jacent** | ∓5% — impératif |
| Hold max | 10 j (échéance 1M) / 14 j (3M) |
| Thêta critique | 1M avec ≤ 7 j restants → vendre |

### Couche 3 — Moteur de risque TIPP (nouveau, v25)

C'est la couche qui transforme les contraintes en **garanties structurelles** :

```
HWM      = plus-haut historique de l'équité (ne descend jamais — ratchet)
Plancher = 58% × HWM
Coussin  = équité − plancher
RÈGLE D'OR : somme des primes ouvertes (valeur de marché) ≤ coussin, toujours.
```

- **Budget global de primes** : chaque jour, les nouvelles entrées sont rognées pour
  que `primes ouvertes + nouvelles primes ≤ coussin`.
- **Règle d'allègement** : si les primes ouvertes dépassent le coussin (forte
  appréciation non prise), alerte Telegram « ALLÉGER X € » — on vend l'excédent.
- **Freins progressifs** (anti cash-lock, on dé-risque bien avant le plancher) :

| Drawdown courant | Sizing |
|---|---|
| < 15% | ×1.00 |
| 15–25% | ×0.60 |
| 25–35% | ×0.35 |
| ≥ 35% | **hard-stop** : 0 entrée (réarmement sous 30% de DD) |

### Preuve des garanties

- **MDD ≤ 45%** : même si *toutes* les primes ouvertes valent 0 du jour au lendemain
  (gap, faillite, journée sans cotation), l'équité reste ≥ plancher = 58% du HWM,
  donc DD ≤ 42% < 45%. Les 3 points de marge absorbent spreads et slippage.
- **Ruine 0%** : équité ≥ 58% × HWM ≥ 58% × capital initial > 0, à tout instant.
  Le plancher ne descendant jamais, aucune séquence de pertes ne peut le percer.
- **Gain maximal sous contraintes** : à DD < 15%, le coussin vaut ≥ 42% de l'équité
  et le sizing Kelly fractionné v22 tourne à plein régime ; quand l'équité monte,
  le HWM et donc le coussin montent avec elle (anti-martingale : on n'augmente
  l'exposition qu'avec les gains).

## 3. Validation Monte-Carlo

`node backtest/backtest_tipp.mjs 400` — 400 runs × 252 jours × 40 tickers,
marché à régimes (calme/stress/panique) + chocs idiosyncratiques, spread 1.5%/côté,
gaps violents aléatoires. Le backtest appelle **les fonctions exactes de production**
(`scanIndicators`, `detectSignal`, `computeSizing`, `blackScholes`, `tippRiskBudget`).

| Métrique (400 runs) | Sans TIPP (v22 brut) | **Avec TIPP (v25)** |
|---|---|---|
| Pire max drawdown | **83.8%** | **36.9%** |
| Runs avec DD > 45% | 2.5% | **0.0%** |
| Ruine | 0 | **0** |
| Rendement p95 à 1 an | +40.3% | +40.3% *(upside préservé)* |
| Violations du plancher | — | **0** |

Mode torture (`--torture` : toutes les primes ouvertes → 0 un jour aléatoire) :

| | Sans TIPP | **Avec TIPP** |
|---|---|---|
| Pire max drawdown | 83.9% | **42.0%** *(= borne théorique exacte)* |
| Runs avec DD > 45% | 3.5% | **0.0%** |

## 4. Intégration dans le worker

- `RISK_CFG` + `tippRiskBudget()` : moteur pur (worker.js).
- `computeRiskContext()` : équité (net liquidity), valeur Black-Scholes des primes
  ouvertes (KV `user_positions`), état persistant du HWM (KV `risk_state`).
- `buildFinalResult()` : applique frein × budget aux signaux (`riskCapped`,
  `riskMult` dans le sizing ; `capital.risk` dans `/signals`).
- Telegram : ligne `🛡 TIPP : DD x% · plancher y€ · budget primes z€` + alerte
  d'allègement + mention HARD-STOP.

## 5. Limites honnêtes

- « Ruine 0% » = garantie *structurelle* au niveau du portefeuille (perte bornée à
  42% du plus-haut). Elle suppose : pas de défaut de l'émetteur du warrant (risque
  de crédit BNP/SG/Unicredit — réel mais marginal), et exécution des ventes
  d'allègement au scan quotidien.
- Le gain n'est **jamais** garanti : la médiane à 1 an du backtest est proche de 0,
  la moyenne légèrement positive, le p95 à +40%. L'edge dépend de la persistance
  du mean-reversion sur SBF120/DAX.
- Backtest sur données synthétiques calibrées (régimes + jumps) : il prouve la
  *mécanique de risque* (bornes exactes), pas la rentabilité future.
- Ceci n'est pas un conseil en investissement.

## Sources

- [Swissquote — Turbo warrants: high-leverage trading](https://www.swissquote.com/en-ch/private/inspire/blog/markets-instruments/turbo-warrants-high-leverage-trading-without-options) · [Neofa — Comprendre et maîtriser les turbos et warrants](https://neofa.com/fr/placement-financier/bourse/comprendre-et-maitriser-les-turbos-et-les-warrants/) · [DayTrading.com — Turbo Warrants strategies](https://www.daytrading.com/turbo-warrants) · [Café de la Bourse — Trader un turbo](https://www.cafedelabourse.com/bourse-investir-turbos)
- [Enlightened Stock Trading — Kelly Criterion](https://enlightenedstocktrading.com/kelly-criterion/) · [Astute Investors Calculus — Kelly position sizing & ruin](https://astuteinvestorscalculus.com/the-kelly-criterion/) · [JournalPlus — Kelly Criterion guide](https://journalplus.co/learn/guides/kelly-criterion-guide/)
- [QuantPedia — Introduction to CPPI](https://quantpedia.com/introduction-to-cppi-constant-proportion-portfolio-insurance/) · [AXA IM — Understanding Portfolio Insurance (CPPI/TIPP)](https://core.axa-im.com/investment-strategies/multi-asset/insights/understanding-portfolio-insurance-management-cppitipp) · [QuantifiedStrategies — CPPI position sizing](https://www.quantifiedstrategies.com/constant-proportion-portfolio-insurance-cppi-position-sizing/) · [Mantilla-García — Dynamic Allocation Strategies for Loss Control](https://simafin.wordpress.com/wp-content/uploads/2014/12/dynamic-allocation-strategies-for-absolute-and-relative-risk-loss-control-mantilla-garcia_2014.pdf)
