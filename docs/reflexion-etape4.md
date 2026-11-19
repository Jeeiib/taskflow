# Étape 4 : questions de réflexion

## Partie A. Instrumenter l'API

### 1. Pourquoi ne jamais exposer `/metrics` sur Internet ?

Parce que ça raconte tout l'intérieur de l'appli à n'importe qui : les routes qui existent, le trafic, le taux
d'erreurs, la version exacte (`taskflow_build_info`), la mémoire et le CPU du process Node. Pour quelqu'un qui prépare
une attaque, c'est une carte gratuite (il voit tout de suite si sa tentative fait monter les 500). Et ça se scrape en
boucle, donc c'est aussi une porte pour charger l'API pour rien.

Chez moi Prometheus le lit directement sur le réseau Docker (`api:3000`), et j'ai mis un `location = /metrics { return 404; }`
dans le Nginx du front, au cas où quelqu'un ajouterait un jour une règle trop large. `curl -sk https://taskflow.localhost/metrics`
renvoie bien un 404.

S'il devait vraiment traverser un réseau public, je le mettrais derrière une authentification (au minimum basic auth
avec TLS, mieux du mTLS avec un certificat client pour Prometheus), et je filtrerais par IP pour n'accepter que le
serveur Prometheus. Ou alors un tunnel/VPN (WireGuard, Tailscale) pour que ça ne soit jamais vraiment « public ».

### 2. Pourquoi un histogramme pour la durée ?

Une gauge « durée de la dernière requête », c'est une seule valeur toutes les 15 s alors qu'il passe peut-être
100 requêtes entre deux scrapes : on voit celle qui tombe au bon moment, les autres sont perdues. Une requête à 3 s
peut passer complètement inaperçue.

L'histogramme compte toutes les requêtes dans des buckets (moins de 5 ms, moins de 10 ms...) avec la somme et le
nombre. Rien n'est perdu, on peut calculer un p95 sur n'importe quelle fenêtre avec `histogram_quantile`, et on peut
agréger plusieurs instances de l'API (une moyenne de gauges, ça ne veut rien dire). C'est le p95 qui montre ce que
vivent les utilisateurs les moins chanceux, la moyenne cache tout (on l'a bien vu dans l'exercice 4.5 : moyenne
291 ms, médiane 13 ms).

### 3. Et si `route` contenait l'URL réelle ?

Chaque valeur différente d'un label crée une nouvelle série temporelle. Avec 100 000 URL différentes, on passe à
100 000 séries par méthode et par code de statut, multipliées par les ~12 séries de chaque histogramme (un par bucket,
plus `_sum` et `_count`). Ça fait plus d'un million de séries. Prometheus garde les séries actives en mémoire : la RAM
explose, les requêtes deviennent super lentes, et au pire il se fait tuer (OOM), donc plus de monitoring du tout au
moment où on en aurait besoin. Côté API aussi, prom-client garde tout ça en mémoire et `/metrics` devient énorme.

C'est pour ça que le label vaut `/api/tasks/:id/toggle` et que tout ce qui ne matche aucune route tombe dans
`unmatched` : un robot qui scanne `/.env`, `/.git/config` & co ne crée qu'une seule série.

## Partie B. La stack de supervision

### 1. Pourquoi sonder `/health` à travers le front ?

Parce que c'est le chemin d'un vrai utilisateur. En passant par `http://front/health`, la sonde teste le Nginx du front,
le proxy vers l'API, l'API et la base (le `/health` de l'API fait un aller-retour en base). Si le front ne joint plus
l'API (mauvaise config Nginx, conteneur `api` renommé...), l'utilisateur voit un 502 et la sonde aussi. En sondant
`api:3000` directement, on aurait une API « verte » alors que le site est cassé.

C'est la différence boîte noire / boîte blanche : `/metrics` c'est la boîte blanche (l'API raconte ce qu'elle voit),
la sonde c'est la boîte noire (on regarde de l'extérieur si ça marche). Et si l'API est complètement morte, elle ne
peut plus rien dire sur elle-même : seule la sonde le voit. D'ailleurs blackbox est exigeant : il faut un 200 ET
`"status":"ok"` dans le corps, un 503 de l'API (base injoignable) compte comme un échec.

### 2. Pourquoi `for: 1m` sur `TaskFlowApiDown` ?

Pour ne pas réveiller quelqu'un pour un raté isolé : un redéploiement qui recrée le conteneur, un timeout réseau d'une
seconde, un scrape qui tombe pile au mauvais moment. Il faut que la sonde soit en échec à chaque évaluation pendant une
minute entière.

Pendant cette minute l'alerte est `pending` : Prometheus la voit (onglet *Alerts*), mais n'envoie rien à Alertmanager.
Si la sonde redevient verte avant la fin, l'alerte disparaît sans bruit. Au bout d'une minute elle passe `firing` et
part vers Alertmanager, qui attend encore son `group_wait` avant d'envoyer le mail. Le prix, c'est qu'on apprend la
panne au mieux 1 min et quelques après son début. C'est exactement ce que vérifie mon test `promtool` (rien à 30 s
d'échec, firing après 1 min 30).

### 3. À quoi sert le Watchdog ?

À prouver que toute la chaîne d'alerte marche. Le silence peut vouloir dire « tout va bien » ou « Prometheus est
mort / Alertmanager ne reçoit plus rien », et de l'intérieur on ne peut pas faire la différence. Le Watchdog est
toujours `firing` : s'il disparaît, c'est que la chaîne est cassée. En vrai on l'envoie vers un service externe de type
« dead man's switch » qui, lui, alerte quand il ne reçoit plus le Watchdog. Ici il est routé vers un receiver vide
pour ne pas spammer Mailpit, mais on le voit actif dans http://localhost:9093.

## Partie C. Lire les logs avec `jq`

L'exercice 4.5 (questions 1 à 6) est fait à part, avec les commandes et les réponses.

Sur mes logs de prod, juste après le déploiement des métriques :

```bash
cd ~/taskflow-prod
docker compose -f compose.prod.yaml logs --no-log-prefix api > /tmp/api.log
jq -r 'select(.path) | "\(.method) \(.path | sub("/[0-9]+"; "/:id"))"' /tmp/api.log | sort | uniq -c | sort -rn | head
jq -c 'select(.status >= 400)' /tmp/api.log | tail
jq -s '[.[] | select(.ms)] | sort_by(.ms) | reverse | .[0:3]' /tmp/api.log
```

Top : `GET /api/tasks` loin devant (ma boucle de trafic), puis `/health` (les healthchecks Docker), `POST /api/tasks`,
`PATCH /api/tasks/:id/toggle`. Les seules 4xx sont mes `GET /api/inconnue` (404) et aucune 5xx. Les trois plus lentes :
un `POST /api/tasks` à 38 ms à 16:47:30 UTC (premier insert après le redémarrage), un `/health` à 27 ms et un
`GET /api/tasks` à 20 ms, donc rien d'inquiétant.

Remarque au passage : il n'y avait que 52 lignes parce que la release venait de recréer le conteneur `api`, et
`docker compose logs` repart de zéro avec le nouveau conteneur. Les compteurs Prometheus aussi repartent à zéro, mais
l'historique, lui, reste dans Prometheus.

### 3. La même requête dans Grafana et dans les logs

Le `POST /api/tasks` de 17:47:30 (heure de Paris) : dans Grafana je le vois comme une petite marche sur la courbe
`/api/tasks` et sur le compteur de tâches créées de cette minute-là. Dans le log j'ai la ligne exacte : heure à la
milliseconde, chemin, statut 201, 38,2 ms.

Ce que le log m'apprend en plus : le détail d'UNE requête (l'id exact dans le chemin, la durée exacte, et en cas
d'erreur le message, comme le `timeout exceeded` de l'exercice). Avec ça je peux enquêter sur un cas précis.

Ce que la métrique m'apprend que le log ne dit pas facilement : la tendance et les proportions dans le temps (débit
par seconde, taux d'erreurs, p95 sur 5 min), agrégées sur toutes les requêtes et sans rien recalculer, et elle survit
au redémarrage du conteneur (dans Prometheus). Elle est aussi beaucoup moins chère à garder longtemps. Les deux se
complètent : la métrique me dit qu'il y a un problème et quand, le log me dit pourquoi.

## Partie D. Incident, post-mortem, amélioration

Le post-mortem complet est dans `docs/INCIDENTS.md` (incident n° 1), et l'issue d'amélioration est la #25.

### 1. Combien de temps entre le début de l'incident et l'alerte ?

1 min 23 s : l'API est recréée à 17:48:58, le mail arrive à 17:50:21. Ça se décompose à peu près comme ça : jusqu'à 15 s
pour que le scrape de la sonde tombe (17:49:11 en *pending*), la minute du `for: 1m`, puis les 10 s du `group_wait`
d'Alertmanager.

Pour réduire : scraper la sonde toutes les 5 s, mettre `for: 30s`, baisser le `group_wait`. On gagnerait peut-être 40 s.
Le prix : plus de fausses alertes (un redéploiement normal fait rater une sonde, je l'ai vu juste avant l'incident à la
release de 17:47), plus de charge de scrape, et des gens qui finissent par ignorer les mails parce qu'ils sonnent pour
rien. Pour une petite appli comme TaskFlow, 1 min 30 c'est un bon compromis. Le vrai gain serait plutôt d'empêcher
l'incident (question 3).

### 2. Pourquoi un rollback ne répare-t-il pas cet incident ?

Parce que la cause n'est pas dans l'image. La version n'a pas bougé (`cbb3a1a` avant, pendant et après, le panneau
« Version en ligne » le montre). Le problème est dans le `.env` de la prod, qui est hors de l'image et hors de Git :
un rollback redéploie une ancienne image, mais avec le même `.env` cassé, donc la même `DATABASE_URL` absente et le même
plantage. C'est un incident de configuration, pas de code. Il faut corriger le fichier et recréer le conteneur.

### 3. Prévention ou détection ?

L'issue #25 (l'API refuse de démarrer en production sans `DATABASE_URL`) et le contrôle `.env` vs `.env.example` dans
`deploy.sh`, c'est de la **prévention** : avec le contrôle dans `deploy.sh`, la coquille est bloquée avant même de
toucher au conteneur ; avec #25, l'API s'arrête tout de suite avec un message clair au lieu de boucler sur un
`ECONNREFUSED` trompeur. Honnêtement #25 seule n'empêche pas la panne si quelqu'un recrée le conteneur à la main, elle
la rend juste évidente à diagnostiquer, c'est pour ça que le contrôle en amont compte aussi.

Le panneau « erreurs vues par l'utilisateur » (codes de la sonde), c'est de la **détection** : il ne change rien à
l'incident, il le rend visible plus vite sur le dashboard.

Oui, les deux sont nécessaires. La prévention couvre les causes qu'on connaît (cette coquille-là), mais la prochaine
panne sera différente : une base pleine, un certificat expiré, autre chose. La détection, elle, marche pour les pannes
qu'on n'a pas encore imaginées. Sans prévention on répare la même chose tous les mois, sans détection on apprend les
pannes par les utilisateurs.
