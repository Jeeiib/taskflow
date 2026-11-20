# Sécurité de TaskFlow

Ce document décrit les contrôles de sécurité du projet, le triage des alertes, ce que j'ai corrigé et le registre des
exceptions. Je le mets à jour à chaque alerte traitée.

## 1. Les contrôles et leur place dans le pipeline

| Contrôle | Outil | Étape | Déclencheur | Ce qu'il protège |
|---|---|---|---|---|
| Secrets (avant le commit) | gitleaks (pre-commit) | poste du dev | `git commit` | un secret qui part dans un commit |
| Secrets (historique) | gitleaks, binaire vérifié par SHA-256 | `security.yml` | PR, push `main`, lundi, manuel | un secret déjà dans l'historique |
| Dépendances (SCA) | `npm audit --audit-level=high` (api et front) | `security.yml` | PR, push `main`, lundi, manuel | dépendances avec une CVE connue |
| Dépendances (veille) | Dependabot | dépôt | planifié | dépendances qui vieillissent |
| Code (SAST) | Semgrep `p/javascript` + `p/nodejsscan` | `security.yml` | PR, push `main`, lundi, manuel | injection SQL, XSS, `eval`, secrets en dur |
| Image (SCA) | Trivy, bloquant sur CRITICAL corrigeable | `release.yml` | push `main` | CVE dans les images publiées |
| Application (DAST) | OWASP ZAP baseline + `.zap/rules.tsv` | `security.yml` | PR, push `main`, lundi, manuel | en-têtes, fuites d'information |
| Durcissement HTTP | en-têtes Nginx du front | runtime | chaque requête | XSS, clickjacking, fuite de version |
| Moindre privilège | `permissions: contents: read`, actions épinglées par SHA | workflows | toujours | un jeton détourné, une action modifiée |

Le `schedule` du lundi sert à rattraper les CVE publiées après un merge, sans que personne ne touche au code.

## 2. Triage des alertes (20/11/2026)

Premier passage de `security.yml` sur la PR #34 : `npm audit api` et `DAST` en rouge, `secrets`, `sast` et
`npm audit front` en vert.

| Alerte | Outil | Sévérité | Vrai ou faux positif ? | Décision |
|---|---|---|---|---|
| Content Security Policy Header Not Set (10038) | ZAP | Medium | vrai | corrigé (CSP dans Nginx) |
| Missing Anti-clickjacking Header (10020) | ZAP | Medium | vrai | corrigé (`X-Frame-Options: DENY` + `frame-ancestors 'none'`) |
| X-Content-Type-Options Header Missing (10021) | ZAP | Low | vrai | corrigé (`nosniff`) |
| Permissions Policy Header Not Set (10063) | ZAP | Low | vrai | corrigé |
| Server Leaks Version Information (10036) | ZAP | Low | vrai (`nginx/1.31.9` affiché) | corrigé (`server_tokens off`) |
| COEP / COOP / CORP manquants (90004) | ZAP | Low | vrai, impact faible (pas de contenu tiers) | corrigé, surveillé en WARN |
| Modern Web Application (10109) | ZAP | Info | faux positif (signale juste une SPA) | IGNORE justifié |
| Storable and Cacheable Content (10049) | ZAP | Info | faux positif (cache voulu sur les assets hashés) | IGNORE justifié |
| `vitest` 2, `@vitest/coverage-v8` 2 et leurs dépendances (`vite`, `tinypool`, `esbuild`, `glob`...) : 3 critical, 1 high, 6 moderate | npm audit (api) | critical | vrai, mais devDependencies : absentes de l'image de prod | corrigé (montée en Vitest 5.1.1) |
| aucune alerte | Semgrep | - | - | rien à faire |
| aucune fuite sur 34 commits | gitleaks | - | - | rien à faire |

Les 4 questions que je me suis posées pour chaque alerte : atteignable en prod ? donnée utilisateur ? impact ?
décision (corriger, issue, exception datée) ?

Pour `vitest`, la faille n'est pas exploitable en prod (le `npm ci --omit=dev` de l'image ne l'installe pas), mais
elle tourne en CI et sur les postes, et laisser `npm audit` rouge en permanence apprend à tout le monde à ignorer le
check. Vitest 5 demande Node 22.12 ou plus : j'ai remplacé Node 20 (plus maintenu) par Node 24 dans la matrice de
`ci.yml` et dans le job d'intégration, et mis à jour les checks obligatoires du ruleset `protection-main`
(`api (20)` remplacé par `api (24)`).

## 3. Durcissement HTTP (en-têtes du front)

Posés dans [`front/nginx.conf`](../front/nginx.conf), sur toutes les réponses (`always`, donc aussi sur les 404 et 502) :

| En-tête | Valeur | Rôle |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | n'autorise que nos propres ressources, bloque la plupart des XSS |
| `X-Content-Type-Options` | `nosniff` | le navigateur ne devine pas le type (pas de JS déguisé en image) |
| `X-Frame-Options` | `DENY` | anti-clickjacking pour les vieux navigateurs |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | l'URL complète ne part pas vers les sites tiers |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | coupe les API matérielles inutilisées |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` / `-Embedder-Policy` | `same-origin` / `same-origin` / `require-corp` | isolation de l'origine (Spectre) |

Plus `server_tokens off` (plus de version de Nginx dans `Server` ni dans les pages d'erreur) et
`proxy_hide_header X-Powered-By` (retire `X-Powered-By: Express` des réponses de l'API). Le `location = /metrics`
qui renvoie 404 (Jour 4) est conservé.

Pas de `'unsafe-inline'` : le build Vite ne produit ni script ni style inline, tout est dans `/assets/*`. J'ai testé
dans le navigateur : création, bascule et suppression de tâche, aucune violation de CSP dans la console.

Piège évité : `add_header` n'est pas hérité par une `location` qui a son propre `add_header`. L'ancien
`location /assets/` posait un `Cache-Control` et aurait perdu la CSP. Le `Cache-Control` des assets passe maintenant
par un `map` au niveau `http`. Vérifié avec `curl -I` sur `/`, `/health` et `/assets/index-*.js` : les en-têtes sont
présents sur les trois.

Re-scan ZAP après correction : `FAIL-NEW: 0`, `WARN-NEW: 0`, 66 règles passées (avant : 5 FAIL, 1 WARN).

HSTS n'est pas posé ici : ce Nginx parle HTTP sur le réseau interne. Il se pose sur le proxy HTTPS de la prod.

## 4. Registre des exceptions

Chaque exception est étroite (une règle ou un chemin précis) et justifiée. Un vrai secret ne s'ajoute jamais ici :
il se révoque.

### ZAP ([`.zap/rules.tsv`](../.zap/rules.tsv))

| Règle | Action | Justification | Qui | Date | Revue |
|---|---|---|---|---|---|
| 10049 Storable and Cacheable Content | IGNORE | informatif, les assets Vite (nom avec hash) sont cachés 1 an exprès | Jeeiib | 20/11/2026 | à la montée de version de ZAP |
| 10109 Modern Web Application | IGNORE | informatif, signale seulement une SPA | Jeeiib | 20/11/2026 | idem |
| 10027 Information Disclosure - Suspicious Comments | IGNORE | mots-clés (`select`, `user`, `TODO`) dans le bundle minifié des bibliothèques, pas dans notre code | Jeeiib | 20/11/2026 | à chaque montée de Vite |
| 90004 COEP / COOP / CORP | WARN | en-têtes posés, surveillés sans bloquer (un futur contenu tiers pourrait les rendre gênants) | Jeeiib | 20/11/2026 | 20/02/2027 |
| 10038, 10020, 10021, 10063, 10036, 10037 | FAIL | en-têtes corrigés : toute régression bloque la PR (test de non-régression de sécurité) | Jeeiib | 20/11/2026 | - |

### gitleaks ([`.gitleaks.toml`](../.gitleaks.toml))

| Exception | Justification | Qui | Date | Revue |
|---|---|---|---|---|
| `*.env.example`, `package-lock.json` | valeurs d'exemple et sommes de contrôle, publiques par construction | Jeeiib | 20/11/2026 | 20/02/2027 |
| `postgres://taskflow:taskflow@…` | mot de passe jetable de la base de dev et des tests, jamais exposé hors du réseau Docker ni du CI | Jeeiib | 20/11/2026 | 20/02/2027 |

### Semgrep

Aucune exception. En cas de faux positif : `// nosemgrep: <id-de-règle>` sur la ligne concernée (jamais un
`nosemgrep` nu) et une ligne datée ici.

## 5. Limites connues

- La baseline ZAP est passive : elle ne teste ni l'authentification, ni les injections (il faudrait un scan actif,
  à planifier sur le staging), ni le contrôle d'accès. Elle ne remplace ni un pentest ni la revue de code.
- Semgrep avec les règles publiques peut rater une injection si la requête SQL est construite dans une autre fonction
  que l'appel : le SAST complète la revue, il ne la remplace pas.
- TaskFlow n'a ni authentification ni multi-utilisateurs : A01 (contrôle d'accès) et A07 (authentification) ne sont
  pas couverts par ce code.
- Les actions de `ci.yml` sont encore épinglées par tag (`@v7`) et pas par SHA, contrairement à `security.yml` et
  `release.yml`.
- Les checks de `security.yml` ne sont pas encore obligatoires dans le ruleset : une PR pourrait être fusionnée avec
  un DAST rouge.

## 6. En cas de secret exposé

1. Révoquer le secret tout de suite (régénérer la clé ou le jeton chez le fournisseur).
2. Le remplacer par une nouvelle valeur, rangée dans un secret GitHub ou un `.env` hors Git.
3. Purger l'historique si besoin (`git filter-repo`) et prévenir l'équipe : l'ancien secret reste dans les clones.
4. Ouvrir un post-mortem, comme pour un incident (`docs/INCIDENTS.md`).
