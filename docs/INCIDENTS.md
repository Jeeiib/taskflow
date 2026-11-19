# Gestion des incidents

Quand ça casse en prod : on répare d'abord, ensuite on comprend, et on écrit ce qu'on a appris. Les post-mortems
sont sans blâme : on parle du système et du processus, jamais des personnes. Chaque post-mortem finit par au moins une
issue.

## Supervision en place

| Outil | Adresse | Sert à |
|---|---|---|
| Mailpit | http://localhost:8025 | recevoir les mails d'Alertmanager |
| Alertmanager | http://localhost:9093 | alertes actives et inhibées, silences pendant une intervention |
| Prometheus | http://localhost:9090 | *Alerts*, *Targets*, requêtes PromQL |
| Grafana | http://localhost:3001 | dashboard *TaskFlow : RED et disponibilité* |

La stack se lance depuis `monitoring/` : `docker compose -f compose.monitoring.yaml up -d` (mot de passe Grafana dans
`monitoring/.env`, hors Git).

| Alerte | Signification | Premier réflexe |
|---|---|---|
| `TaskFlowApiDown` (critical) | `/health` ne répond pas `ok` à travers le front depuis 1 min | méthode ci-dessous |
| `TaskFlowMetricsDown` (warning) | Prometheus ne lit plus `api:3000/metrics` | `ps` : l'API tourne ? |
| `TaskFlowHighErrorRate` (warning) | plus de 5 % de 5xx pendant 5 min | logs `level=error`, état de la base |
| `TaskFlowHighLatency` (warning) | p95 > 300 ms pendant 5 min | panneau Duration par route, base, ressources |

## Méthode de diagnostic

Du plus visible au plus profond, dans `~/taskflow-prod` :

1. **Alerte** : laquelle, depuis quand (`activeAt`), quelle cible ? L'heure de réception = début de la chronologie.
2. **Dashboard** : depuis quand la dispo est tombée, la version a changé ou pas, les courbes montent (erreurs) ou
   s'arrêtent (API morte) ?
3. **Symptôme** : `curl -sk https://taskflow.localhost/health`.
4. **Conteneurs** : `docker compose -f compose.prod.yaml ps` (`unhealthy`, `Restarting` ?).
5. **Logs** filtrés : `docker compose -f compose.prod.yaml logs --no-log-prefix --since 15m api | jq -c 'select(.level != "info")'`.
6. **Cause racine** : la prouver (`docker inspect`, le fichier, une requête), pas la deviner.
7. **Correction** puis **vérification** : `ps`, `/health`, une création de tâche, sonde verte, mail `[RESOLVED]`.

Recréer l'API à la main sans changer de version : `IMAGE_TAG=$(cat .deployed_tag) docker compose -f compose.prod.yaml up -d --no-deps api`.
Sans `IMAGE_TAG`, Compose prend celui du `.env` (`latest`).

Pendant une intervention longue, un silence dans Alertmanager (avec un commentaire et une durée) évite de recevoir la
même alerte en boucle.

## Modèle de post-mortem

À copier pour chaque incident, du plus récent au plus ancien.

```markdown
## Incident n° N - Titre court

**Gravité** : faible / moyenne / élevée
**Détection** : alerte <nom> / utilisateur / autre - délai entre le début et la détection : X min
**Durée** : début hh:mm - fin hh:mm (durée totale = temps de rétablissement)
**Rédaction** : ...

### Résumé
Deux ou trois phrases : ce qui s'est passé et l'impact pour les utilisateurs.

### Chronologie (heure, UTC ou locale : préciser)
- hh:mm - Changement à l'origine de l'incident
- hh:mm - Premier signal (alerte, message d'un utilisateur...)
- hh:mm - Diagnostic : ce qu'on a regardé, ce qu'on a trouvé
- hh:mm - Correction appliquée
- hh:mm - Retour à la normale confirmé (sonde verte, [RESOLVED])

### Cause racine (5 pourquoi)
1. Pourquoi ... ?
...

### Ce qui a bien fonctionné
### Ce qui a moins bien fonctionné

### Actions
| Action | Type | Issue | Statut |
| --- | --- | --- | --- |
| ... | prévention / détection / processus | #N | à faire |
```

---

## Incident n° 1 - L'API redémarre en boucle après une coquille dans le `.env` de la prod

**Gravité** : élevée (le site entier est inutilisable)
**Détection** : alerte `TaskFlowApiDown` par mail (Mailpit) - délai entre le début et la détection : 1 min 23 s
**Durée** : début 17:48:58 - fin 17:51:09, heure de Paris, le 19/11/2026 (temps de rétablissement : 2 min 11 s)
**Rédaction** : Jeeiib

### Résumé

Une modification du `.env` de la production a renommé `DATABASE_URL` en `DATABASE_UR`. Au redémarrage, l'API n'a plus
reçu l'adresse de la base, a essayé de se connecter à `localhost` et a planté en boucle. Pendant un peu plus de 2 minutes,
toutes les requêtes du site ont échoué (502 Bad Gateway, ou timeout) : impossible de lister, créer ou modifier une tâche.
Aucune donnée perdue, la base n'a jamais été touchée.

Mesure de l'impact : un client qui appelait `GET /api/tasks` toutes les 3 s pendant l'incident a eu 36 échecs sur 36
requêtes entre 17:49:00 et 17:51:02 (33 × 502, 3 timeouts).

### Chronologie (heure de Paris, UTC+1)

- 17:48:58 - « Déploiement » : le `.env` de la prod est modifié (`DATABASE_UR=` au lieu de `DATABASE_URL=`) et le
  conteneur `api` est recréé avec la même image (`cbb3a1a`).
- 17:49:00 - Premier log `fatal` de l'API : `Démarrage impossible : ECONNREFUSED`. Premier 502 côté utilisateur.
- 17:49:11 - Prometheus : `TaskFlowApiDown` et `TaskFlowMetricsDown` passent en *pending* (sonde à 0, cible
  `api:3000` DOWN).
- 17:50:11 - Les deux alertes passent en *firing* (après le `for: 1m`). Alertmanager inhibe `TaskFlowMetricsDown`
  (warning) derrière `TaskFlowApiDown` (critical) : un seul mail.
- 17:50:21 - **Premier signal** : mail `[FIRING:1] TaskFlowApiDown prod (http://front/health ...)` dans Mailpit.
- 17:50:30 - Prometheus : `probe_http_status_code` = 502 (le front ne joint pas l'API), `up{job="taskflow-api"}` = 0,
  plus de `taskflow_build_info` (l'API ne répond plus du tout). Aucune 5xx comptée par l'API.
- 17:50:40 - `curl -sk https://taskflow.localhost/health` : 502 Bad Gateway de Nginx. `docker compose ps` : `api`
  en `Restarting (1)`, `db` healthy depuis 3 h.
- 17:50:45 - Logs de l'API filtrés avec `jq` : un `fatal` `ECONNREFUSED` toutes les quelques secondes depuis 17:49:00,
  avec l'indice « Vérifiez DATABASE_URL ».
- 17:50:50 - Cause prouvée : `docker inspect taskflow-prod-api-1` montre que le conteneur ne reçoit **pas** de
  `DATABASE_URL` ; `diff .env.bak .env` (mot de passe masqué) montre la seule différence, `DATABASE_URL` →
  `DATABASE_UR`. Dans `api/src/config.js`, une `DATABASE_URL` absente fait retomber sur `localhost:5432`, c'est-à-dire
  le conteneur de l'API lui-même, d'où le `ECONNREFUSED`.
- 17:51:02 - Correction : nom de la variable remis dans `.env` (vérifié identique à `.env.bak`), conteneur `api`
  recréé (l'`env_file` n'est lu qu'à la création, un simple `restart` n'aurait rien changé).
- 17:51:09 - **Retour du service** : `api` healthy, `/health` répond `{"status":"ok","db":"up","version":"cbb3a1a"}`,
  création d'une tâche OK (201).
- 17:51:15 - Sonde blackbox de nouveau à 1 dans Prometheus et Grafana.
- 17:51:30 - Conteneur recréé une seconde fois avec `IMAGE_TAG=cbb3a1a` : la première recréation avait pris le tag
  `latest` du `.env` (même image, mais plus le tag exact du déploiement).
- 17:52:21 - Mail `[RESOLVED] TaskFlowApiDown` dans Mailpit. `.env.bak` supprimé.

Temps de détection : 1 min 23 s (17:48:58 → 17:50:21). Temps de diagnostic : environ 40 s. Temps de rétablissement
(MTTR) : 2 min 11 s jusqu'au retour du service, 3 min 23 s jusqu'au `[RESOLVED]`.

### Ce que l'alerte et le dashboard ont apporté

L'alerte a donné tout de suite la bonne piste : la sonde passe par le front, et `probe_http_status_code` = 502 voulait
dire « Nginx est là mais ne joint pas l'API ». La version en ligne n'avait pas changé (`cbb3a1a` avant et après), donc ce
n'était pas une nouvelle image : il fallait chercher dans la configuration, et un rollback n'aurait servi à rien.

Le panneau « Erreurs 5xx » ne montrait presque rien, et c'est normal : il compte les 5xx renvoyées **par l'API**. Une API
qui ne démarre pas ne répond rien et ne compte rien ; les 502 viennent de Nginx. Ce qui montrait la panne, c'est
la disponibilité (sonde) et les courbes de trafic qui s'arrêtent net.

### Cause racine (5 pourquoi)

1. Pourquoi le site renvoyait-il des 502 ? Parce que le front n'arrivait plus à joindre l'API, qui redémarrait en boucle.
2. Pourquoi l'API redémarrait-elle en boucle ? Parce qu'elle plantait au démarrage sur `ECONNREFUSED` en se connectant
   à PostgreSQL.
3. Pourquoi `ECONNREFUSED` alors que la base était saine ? Parce que l'API ne visait pas `db:5432` mais
   `localhost:5432`, c'est-à-dire son propre conteneur, où rien n'écoute.
4. Pourquoi `localhost` ? Parce que le conteneur ne recevait pas `DATABASE_URL` (écrite `DATABASE_UR` dans le `.env`),
   et que `readConfig` retombe en silence sur une valeur par défaut faite pour le développement local.
5. Pourquoi une coquille dans le `.env` a-t-elle pu atteindre la prod sans être vue ? Parce que le `.env` de la prod est
   modifié à la main, hors Git, et que rien ne le vérifie : ni `deploy.sh`, ni l'API au démarrage (elle accepte une
   config incomplète en production), ni un smoke test après une recréation manuelle du conteneur.

### Ce qui a bien fonctionné

- L'alerte est arrivée seule, 1 min 23 s après le début, sans que personne ne regarde le site.
- L'inhibition d'Alertmanager : un seul mail (`TaskFlowApiDown`) alors que deux alertes étaient en *firing*.
- La sonde boîte noire à travers le front : elle a vu la panne comme un utilisateur, avec le code 502.
- Les logs JSON + `jq` : en une commande, que les lignes `fatal`, avec un indice qui pointait vers `DATABASE_URL`.
- La copie `.env.bak` a permis de prouver la différence par un `diff` au lieu de la deviner.
- Le `for: 1m` a fait son travail juste avant : la recréation de l'API par la release de 17:47 avait fait rater une
  sonde, sans déclencher d'alerte.

### Ce qui a moins bien fonctionné

- Le panneau « Erreurs 5xx » est trompeur quand l'API est complètement morte : il reste plat.
- Le message de l'API (`ECONNREFUSED`, « vérifiez DATABASE_URL ») ne dit pas que la variable est **absente** : il faut
  aller voir l'environnement du conteneur pour le comprendre.
- Le changement de configuration n'est passé par aucun contrôle : pas de comparaison avec `.env.example`, pas de smoke
  test, et l'API démarre (ou essaie) avec un défaut de dev en production.
- La recréation manuelle du conteneur a d'abord pris le tag `latest` du `.env` au lieu du tag déployé. Pas d'impact
  ici (même image), mais le même geste pendant une release aurait pu changer de version sans le vouloir. La commande
  correcte est maintenant dans la méthode de diagnostic ci-dessus.

### Actions

| Action | Type | Issue | Statut |
| --- | --- | --- | --- |
| L'API refuse de démarrer en production si `DATABASE_URL` est absente, avec un message explicite (test dans `tests/config.test.js`) | prévention | [#25](https://github.com/Jeeiib/taskflow/issues/25) | à faire |
| `deploy.sh` compare les noms de variables du `.env` à `.env.example` et s'arrête s'il en manque une | prévention | à créer | à faire |
| Panneau Grafana des erreurs vues **par l'utilisateur** (`probe_http_status_code` de la sonde) à côté des 5xx de l'API | détection | à créer | à faire |
| Commande de recréation de l'API avec le tag de `.deployed_tag` dans la méthode de diagnostic | processus | - | fait (ce document) |
