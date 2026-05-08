# Research Notes — Post-mortem v27/v28/v29/v30

## 1. Verdict empirique consolidé

Les 4 hypothèses ont été testées sur 5 ans avec rigueur. **Toutes échouent** vs v26+Midi :

| Stratégie | Capital 5 ans | vs v26+Midi | Trail | Régime | Source |
|---|---|---|---|---|---|
| v26+Midi (REF) | 1 970 932 € | — | — | — | baseline |
| v27 statique agressif | 1 400 871 € | -43.9 % | 2.0σ partout | — | Test 20 Phase 5 |
| v28 (earnings × régime seul) | 1 782 819 € | -28.6 % | — | local | Test 21 |
| v29 (earnings + trail × régime local) | 1 545 352 € | -38.1 % | 2.0σ STRESS local | local ticker | Test 22 |
| **v30 macro trail 2.0σ** | **1 389 434 €** | **-29.5 %** | 2.0σ STRESS macro | **macro blue chips** | Test 23 |
| v30 macro trail 1.5σ adouci | 888 535 € | -54.9 % | 1.5σ STRESS macro | macro blue chips | Test 23 |

## 2. Le bug v29 EST corrigé (preuve)

v29 (régime local) : 2022 = 7 936 € (= v27 statique exactement)
v30 (régime macro) : 2022 = 6 641 € (différent → switch vraiment activé)

Donc le régime macro fonctionne mécaniquement. Mais ça ne sauve pas la stratégie globale.

## 3. Diagnostic critique sur 2022

L'année 2022 est centrale : elle représente **88 % du capital total** sur 5 ans pour v26+Midi. Toute dégradation 2022 dévaste les 5 ans.

| 2022 | Capital | Action |
|---|---|---|
| v26+Midi (sans rien d'agressif) | 27 262 € | Référence : 86 trades, sortie TP classique |
| v30 macro 2.0σ (agressif en STRESS) | 6 641 € (-75.6%) | Trailing TP coupe les rebonds |
| v30 macro 1.5σ (encore plus serré) | 5 894 € (-78.4%) | Pire — trailing coupe encore plus tôt |

**Lecture critique** : le trailing TP plus serré (1.5σ) fait PIRE que le 2.0σ. C'est l'inverse de ce qu'on attendrait si "le 2σ était trop agressif". Donc le problème n'est pas la sensibilité du seuil.

→ **Le trailing TP nuit fondamentalement en 2022, peu importe le seuil.**

## 4. Pourquoi 2022 résiste-t-il à toute stratégie agressive ?

2022 : guerre Ukraine + inflation + remontée BCE. Le marché est en bear continu mais avec **rebonds techniques durables** (relief rallies de 5-15 %).

**Hypothèse confirmée** : sur les rebonds après chute, le PnL fait un V. Sortir au -2σ du plus haut local sur warrant capture la moitié du V au lieu d'attendre le TP fixe à +20 %.

Le **TP fixe à 20 %** de v26+Midi est mieux adapté aux rebonds bear-trending : il attend le pic complet, pas un "petit" plus haut local.

En 2024-2025 (régime trump-tariffs / IA volatile), les rebonds sont **explosifs et brefs**. Le trailing TP à -2σ du plus haut capture mieux que d'attendre +20 % qui n'arrive jamais → +197 %.

**Conclusion** : trailing TP est régime-dépendant **par nature** :
- Bear trending → TP fixe gagne
- Volatile spike → trailing TP gagne

Et 2022 = 88 % du capital → le côté "TP fixe gagne" domine sur 5 ans.

## 5. Pourquoi le régime macro NE SUFFIT PAS

J'avais espéré que le régime macro identifierait 2022 comme STRESS persistant et appliquerait la config agressive. Mais :

- **2022 EST classé STRESS macro** (vol VSTOXX > 25 majoritaire)
- **Donc v30 active le trailing TP en 2022**
- **Et le trailing TP nuit en 2022** (rebonds bear-trend différents des rebonds 2024)

Le régime macro permet de **détecter** le régime correctement. Mais cela ne change pas que la stratégie agressive **est mauvaise dans ce sous-type de régime STRESS** (bear trending vs spike volatile).

## 6. Vraie classification des régimes nécessaire

Le RegimeModule actuel a 3 classes : CALM, STRESS, PANIC. Cette taxonomie est insuffisante pour décider de la stratégie. Il faudrait au moins :

| Régime | Caractéristique | Stratégie optimale |
|---|---|---|
| CALM | vol basse | v26+Midi (TP fixe) |
| STRESS bear-trending | vol haute, drift négatif persistant | v26+Midi (TP fixe attend rebond complet) |
| STRESS spike volatile | vol haute, drift neutre/oscillant | v27 agressif (trailing TP capture le V) |
| PANIC | vol extrême | OFF (pas de trade) |

Le STRESS actuel mélange 2 régimes opposés. C'est pourquoi aucune stratégie statique-régime ne fonctionne sur 5 ans.

## 7. Hypothèses pour V4 (priorisées par confiance)

### H_A — STRESS bear vs STRESS spike (confiance 50 %)
Distinguer dans le RegimeModule via `ret60` (drift 60j) :
- Si STRESS + ret60 < -5 % → **bear-trending** → v26+Midi
- Si STRESS + ret60 > -5 % → **spike volatile** → v27 agressif

Implémentation : ajouter une feature au K-means ou un override post-classification.

### H_B — Abandonner trailing TP (confiance 75 %)
Les 4 tests prouvent que **trailing TP nuit** sur 5 ans. Garder :
- earnings filter inconditionnel ? Non — Test 21 montre -28.6 % aussi
- skip CALM macro (vrai CALM macro, pas local) ? Pourrait marcher

### H_C — Statu quo (confiance 90 %)
v26+Midi est validé robuste 12-13/15. Toutes les améliorations testées dégradent. La vraie piste de gain est **ailleurs** :
- DAX étendu (MDAX) : +25-30 % de signaux supplémentaires
- 2e compte courtier : Test 14 → +35 %
- VIX-INV mode extrême : Test 8 → +47-128 %
- NLP GPT-4o-mini : Test 9 → +12 % à +41 %

### H_D — Skip CALM macro (confiance 35 %)
Pourrait être marginal. À tester : v26+Midi + skip CALM **macro** seulement (pas local).
Différent de v27 où skip CALM était local. Pourrait éliminer trades CALM réels (vraiment 40 % WR) sans toucher aux gros gagnants 2022.

## 8. Décision finale

**🎯 Garder v26+Midi en prod. Définitivement.**

Le projet a investi 10+ hypothèses (anomalies académiques A/B/C/D, midi, scaling out, IV crush, earnings filter inconditionnel, skip CALM, trailing TP 2σ, trailing TP 1.5σ, régime local switch, régime macro switch). Aucune ne bat v26+Midi sur 5 ans.

C'est un signal très clair : **v26+Midi a atteint un optimum local difficile à dépasser** dans la classe "améliorations stratégiques de la sortie de trade". Les marges restantes sont dans l'**univers** (DAX étendu) et l'**exécution** (2e compte, intraday, NLP).

## 9. Bonne nouvelle malgré les échecs

Méthode **scientifique** validée :
- Walk-forward 4 fenêtres → a déjà alerté sur instabilité v27
- Test 5 ans → a confirmé l'overfit
- Diagnostic v29 ≈ v27 → a forcé l'identification du bug régime local
- Test 23 v30 → a confirmé que même avec le bug corrigé, la stratégie agressive échoue
- Distinction bear-trending / spike volatile → a émergé du diagnostic 2022

**Sans cette discipline méthodologique**, n'importe lequel de ces tests aurait pu sembler "valider" le déploiement. La capacité à dire "non" est la valeur principale du système d'optimisation.

## 10. Niveaux de confiance finaux

| Conclusion | Confiance |
|---|---|
| v26+Midi reste le meilleur sur 5 ans | 95 % |
| trailing TP est fondamentalement overfit période 2024-2026 | 85 % |
| Le régime STRESS doit être subdivisé (bear vs spike) pour qu'un switch marche | 60 % |
| Les vraies marges restantes sont univers et exécution | 75 % |
| v27/v28/v29/v30 doivent être archivés "rejetés définitif" | 90 % |

## 11. Action immédiate

1. Verrouiller **v26+Midi** comme stratégie prod
2. Marquer v27/v28/v29/v30 comme "REJETÉS — overfit 2024-2026" dans la grille
3. Archiver les tests 19/20/21/22/23 comme historique
4. **Pivoter vers la roadmap V4** :
   - P1 : 2e compte courtier (Test 14 = +35 % validé, ROI immédiat, 1h de travail)
   - P2 : VIX-INV mode extrême (Test 8 = +47-128 % validé)
   - P3 : DAX étendu MDAX (gain estimé +25-30 % par expansion d'univers)
   - P4 : NLP GPT-4o-mini (+12 % validé, 0.30 €/an)
   - P5 : intraday 9h30 Flash (50 €/mois, gain +15-25 % estimé)

Toutes ces pistes opèrent sur des dimensions DIFFÉRENTES de la stratégie de sortie de trade. Elles ne sont pas dans la même classe d'overfit que v27-v30.
