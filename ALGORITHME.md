# WARRANTPRO v27 — Algorithme d'achat/vente de warrants avec garantie structurelle de risque

> **Objectifs imposés** : gain maximal sur 1 an · risque de ruine 0% · max drawdown ≤ 45%
> · fréquence exploitable (~5-6 signaux/mois) · signaux exécutables sur des warrants réellement cotés.
>
> On ne peut pas *promettre* un gain (personne ne le peut), mais on peut **garantir
> mathématiquement** les contraintes de risque et maximiser le gain *sous* ces
> contraintes. v26 = edge mean-reversion (signaux par paliers auto-calibrés) +
> stop suiveur + déploiement du coussin, le tout dans une enveloppe **TIPP**
> (plancher cliqueté) qui rend la ruine impossible par construction.

---

## 1. Architecture (issue de la recherche)

| Couche | Rôle | Fondement |
|---|---|---|
| Signaux MR par paliers (H/M/L) | détecter les sur-réactions baissières | short-term reversal (Jegadeesh 1990) |
| Sizing Kelly fractionné + VIX | grader la qualité par la taille | Kelly fractionné (¼–½ Kelly) |
| **Stop suiveur 20/50** (v26) | laisser courir les gagnants | littérature trailing-stop vs TP fixe |
| **DEPLOY** (v26) | déployer le coussin TIPP inutilisé | Moreira & Muir 2017 (vol-managed) |
| **Moteur TIPP** (v25) | garanties ruine 0% / MDD ≤ 45% | CPPI/TIPP à plancher cliqueté |

**Testé et REJETÉ — sleeve momentum** (pullback ATM, ITM 12%, TSMOM 126j ITM 15%) :
le théta + les spreads des warrants détruisent l'edge momentum (−360 à −2 900 €/run
sur toutes les variantes). Le momentum se trade en actions/ETF, pas en warrants.
Voir `backtest_tipp.mjs --variants` (variante « MOMO (rejeté) » conservée comme preuve).

## 2. Les signaux (v26.1 — paliers calibrés en fréquence)

L'ancien filtre unique (z<−2.0 **et** RSI<30 **et** squeeze **et** |ret63|<15, durci à
|z|≥3.0 en régime STRESS) produisait ~1 signal toutes les 6 semaines en réel.
v26.1 le remplace par des paliers — la qualité est graduée par le **sizing**, pas
par un couperet binaire, et le moteur TIPP borne le risque global de toute façon :

| Palier | Conditions | Sizing |
|---|---|---|
| **H** ★★★ | z<−2.5 · RSI<30 · \|ret63\|<15 | 12–25% |
| **M** ★★ | z<−2.0 · RSI<35 · (squeeze OU vol5/vol21≥1.25) · \|ret63\|<18 | 7–12% |
| **L** ★ | z<**zL** · RSI<40 · squeeze · \|ret63\|<18 | 3–7% |
| **PUT** ★★ | z>+2.5 · RSI>72 · \|ret63\|<18 | 7–12% |

- En régime STRESS, seul le palier L est filtré (au lieu de quasi tout avant).
- **Auto-calibration** : `GET /calibrate` rejoue 1 an de données réelles de l'univers
  avec les conditions exactes, mesure les signaux/mois pour chaque seuil zL
  ∈ [−2.2, −1.4] et retient celui qui vise `TARGET_SIGNALS_MONTH` (défaut 5.5/mois).
  Stocké en KV `signal_tuning`, appliqué automatiquement aux scans suivants.
  Plan gratuit Cloudflare : appeler `/calibrate?batch=a` **puis** `/calibrate?batch=b`.

### Exécutabilité (correction « warrant introuvable »)

Le message Telegram recommande désormais un warrant **réellement coté** :
- **strike arrondi à la grille émetteur** (155€/160€, pas 155.20€) + strike voisin de repli ;
- **échéance listée 2-3 mois** (signaux 1M) ou **3-5 mois** (3M) — jamais <6 semaines (théta) ;
- critères de sélection : **delta 0.40–0.60 · spread ≤3% · levier ~×5-8**, tout émetteur acceptable ;
- consigne d'investir **le montant en €** (la quantité dépend du prix coté et de la
  parité 10:1 ou 100:1 — le prix BS théorique parité 1:1 n'est qu'une référence).

## 3. Les sorties (v26 — stop suiveur 20/50)

| Règle | Seuil |
|---|---|
| 🎯 **Stop suiveur** | dès warrant **+20%** (sur prix d'achat réel) : vendre si retombée sous *entrée + 50% du gain max* |
| ⛔ Stop-loss | sous-jacent ∓5% — impératif |
| ⏰ Hold max | 10 j (1M) / 14 j (3M) |
| ⌛ Théta critique | 1M avec ≤7 j restants |

Le TP fixe +25% coupait les gagnants ; le trail 20/50 a **doublé le rendement moyen**
à pire-DD inchangé dans l'ablation (le worker reconstruit le pic du warrant depuis
l'entrée via Black-Scholes sur les clôtures du sous-jacent).

## 4. Le moteur de risque — deux modes (v27)

Règle commune (garantit la **ruine 0%** dans les deux modes) : la perte max d'un
warrant = sa prime, donc on impose **`somme des primes ouvertes ≤ coussin = équité − plancher`**.
Même si tous les warrants ouverts tombent à 0, l'équité reste ≥ plancher > 0.

### Mode GUARD — contrôle du drawdown (MDD ≤ 42%)
```
Plancher = 58% × plus-haut historique de l'équité (cliquette, ne descend jamais)
```
- Freins progressifs : DD≥15% → ×0.60 · DD≥25% → ×0.35 · DD≥35% → hard-stop.
- **Preuve MDD ≤ 45%** : équité ≥ 58% du HWM → DD ≤ 42% (marge 3 pts spreads/slippage).
- Coût : sur longue durée, le plancher qui monte avec les gains force à lever le pied
  → CAGR médian 5 ans ≈ 3,4%.

### Mode GROWTH — maximise le gain (défaut v27)
```
Plancher = floorPct × CAPITAL INITIAL (fixe, ne monte pas avec les gains)
```
- **Aucun frein**, déploiement agressif du coussin (`deployBoostMax 2.0`, cap signal 40%).
- **Ruine toujours impossible** : équité ≥ floorPct × capital de départ > 0.
- Mais le plancher ne cliquète pas → on accepte de **gros drawdowns depuis les sommets**
  pour laisser le gain composer. `floorPct` réglable via `RISK_FLOOR_PCT`.

**Balayage du plancher (backtest `--risk`, ruine = 0 partout) :**

| Mode | Médiane 1 an | Médiane 5 ans (CAGR) | Moyenne 5 ans (CAGR) | p95 5 ans | DD médian | p5 (cas défavorable) |
|---|---|---|---|---|---|---|
| **GUARD** (DD≤42%) | +7,6% | +18% (**3,4%/an**) | +101% (15%/an) | +483% | 35% | −34% |
| GROWTH 50% | −4% | −32% (−7%/an) | +762% | +2946% | 67% | −50% |
| GROWTH 30% | +9% | +5% (1%/an) | +1106% | +3090% | 77% | −70% |
| GROWTH 20% | +9% | +25% (4,5%/an) | +1147% | +3285% | 81% | −80% |
| **GROWTH 15%** (défaut) | +9% | ~+35% (~6%/an) | ~+1150% (~66%/an) | +3200% | ~83% | ~−85% |
| GROWTH 10% | +10% | +49% (**8,3%/an**) | +1151% (66%/an) | +3220% | 84% | −90% |

**Lecture honnête** :
- L'« explosion » du gain est réelle mais surtout dans la **moyenne** et le **p95** (queue
  loterie : 1 run sur 20 dépasse +3000% à 5 ans). La **médiane** — l'expérience la plus
  probable d'un compte unique — ne progresse que modestement (3,4% → 8,3% de CAGR).
- Elle s'achète par un **risque de queue sévère** : en mode agressif, le 5e percentile
  perd 80-90% du capital sur 5 ans (jamais ruiné, mais quasi-anéanti dans les mauvais cas).
- La zone **plancher 30-50% est à éviter** (« trou ») : gros DD **et** médiane médiocre.
  Si on passe en GROWTH, il faut un plancher **bas** (≤20%) pour battre GUARD en médiane.
- `RISK_FLOOR_PCT` permet de doser ; `RISK_MODE=GUARD` revient au contrôle du drawdown.

## 5. Validation Monte-Carlo

`node backtest/backtest_tipp.mjs 400 [--variants|--torture]` — 400 runs × 252 j ×
40 tickers, marché à régimes + chocs + réversion partielle post-choc + tendances AR(1),
spread 1.5%/côté, gaps forcés. Les décisions passent par les **fonctions exactes de
production** (`scanIndicators`, `detectSignal`, `computeSizing`, `tippRiskBudget`…).

| Métrique (400 runs, signaux v26.1) | v25 (TP fixe) | **v26 (trail+DEPLOY)** | v26 sans moteur |
|---|---|---|---|
| Rendement moyen 1 an | +9.9% | **+22.7%** | +29.2% |
| Rendement médian | +2.4% | **+7.1%** | +9.4% |
| p95 | +79% | **+132%** | +187% |
| Pire max drawdown | 38.7% | **38.9%** | **84.9%** |
| Runs DD>45% | 0 | **0** | **95/400 (24%)** |
| Ruine / violations plancher | 0 | **0 / 0** | 0 / — |
| Trades/an (40 tickers) | 57 | 53 | 60 |

Mode torture (toutes les primes → 0 un jour aléatoire) : pire DD **42.0%** avec moteur
(= borne théorique exacte), 84.9% sans. La colonne « sans moteur » montre le prix du
gain brut : 1 chance sur 4 de dépasser 45% de DD — le moteur TIPP capture ~78% du
gain en éliminant ce risque.

## 6. Exploitation

1. Déployer `worker.js`, lancer **`/calibrate?batch=a` puis `?batch=b`** une fois
   (et après tout changement d'univers) → vise 5-6 signaux/mois sur données réelles.
2. `/ping` → version `worker_v27_growth` + `riskMode` actif ; `/signals` expose
   `capital.risk` (mode, plancher, DD, budget primes) ; ligne mode dans chaque Telegram.
3. Synchroniser les positions (bouton « Sync vers worker ») pour que le budget de
   primes et les recommandations de vente (trail/SL/théta) soient justes.
4. Variables d'env :
   - `RISK_MODE` = `GROWTH` (défaut, max gain) ou `GUARD` (DD ≤ 42%).
   - `RISK_FLOOR_PCT` = plancher en mode GROWTH (0.10 très agressif … 0.50 prudent ; défaut 0.15).
   - `TARGET_SIGNALS_MONTH` = cible de fréquence des signaux (défaut 5.5).

## 7. Limites honnêtes

- « Ruine 0% » = garantie structurelle au niveau portefeuille ; suppose l'absence de
  défaut émetteur (BNP/SG/Unicredit) et l'exécution des ventes d'allègement au scan quotidien.
- Le gain n'est jamais garanti : médiane +7%, moyenne +23%, p5 −32% — l'espérance
  est portée par la queue droite (p95 +132%).
- Backtest sur générateur synthétique calibré sur les anomalies documentées
  (short-term reversal, momentum) : il prouve la mécanique de risque et compare les
  variantes à générateur constant — il ne prédit pas la rentabilité future.
- La fréquence 5-6/mois est calibrée sur les 12 derniers mois réels via `/calibrate` ;
  recalibrer trimestriellement.
- Ceci n'est pas un conseil en investissement.

## Sources

- **Combinaison MR + momentum** : [Kinlay — Combining Momentum & Mean Reversion](https://jonathankinlay.com/2018/10/combining-momentum-mean-reversion-strategies/) · [Balvers & Wu (J. Banking & Finance)](https://www.sciencedirect.com/science/article/abs/pii/S0378426610001883) — testé, rejeté pour les warrants (coûts).
- **Vol-managed / sizing** : [Moreira & Muir 2017 — Volatility-Managed Portfolios (NBER w22208)](https://www.nber.org/papers/w22208) · [Kelly fractionné](https://enlightenedstocktrading.com/kelly-criterion/) · [Astute Investors Calculus](https://astuteinvestorscalculus.com/the-kelly-criterion/)
- **Sorties** : [Algoji — Profit Target vs Trailing Stops](https://algoji.com/profit-target-vs-trailing-stops/) · [The Robust Trader — Trailing Stop Loss](https://therobusttrader.com/trailing-stop-loss/) · [Optimus Futures — Fixed Targets vs Trailing](https://optimusfutures.com/tradeblog/archives/the-pros-cons-fixed-targets-vs-trailing-stop-technique)
- **Enveloppe de risque** : [QuantPedia — Introduction to CPPI](https://quantpedia.com/introduction-to-cppi-constant-proportion-portfolio-insurance/) · [AXA IM — CPPI/TIPP](https://core.axa-im.com/investment-strategies/multi-asset/insights/understanding-portfolio-insurance-management-cppitipp) · [Mantilla-García — Dynamic Loss Control](https://simafin.wordpress.com/wp-content/uploads/2014/12/dynamic-allocation-strategies-for-absolute-and-relative-risk-loss-control-mantilla-garcia_2014.pdf)
- **Produit warrant** : [Swissquote — Turbo warrants](https://www.swissquote.com/en-ch/private/inspire/blog/markets-instruments/turbo-warrants-high-leverage-trading-without-options) · [Neofa — Turbos et warrants](https://neofa.com/fr/placement-financier/bourse/comprendre-et-maitriser-les-turbos-et-les-warrants/)
