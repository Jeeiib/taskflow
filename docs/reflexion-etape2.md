# Étape 2 : questions de réflexion

## Partie A. Déploiement manuel de la production

### 1. Code, configuration ou données : qu'est-ce que le pipeline a le droit d'écraser ?

- **Code** : `compose.prod.yaml`, les scripts `*.sh`, `nginx/taskflow.conf` et surtout les images. C'est la seule
  catégorie que le pipeline a le droit d'écraser : son rôle est de livrer une nouvelle version.
- **Configuration** : `.env` (secrets, propriétaire des images, ports) et `certs/`. Elle est propre à ce serveur, je
  l'ai créée à la main, et le pipeline n'y touche jamais.
- **Données** : le volume `pgdata` et `backups/`. Rien ne doit les écraser.
- `.deployed_tag` et `.previous_tag` sont un état de déploiement, tenu à jour par `deploy.sh` lui-même.

### 2. Où est la configuration (facteur III de 12-factor) ?

Elle est dans le `.env` du serveur, injecté dans les conteneurs par `env_file`. L'image ne contient ni mot de passe ni
URL : c'est la même image partout, seul le `.env` change.

Ce qui rendrait impossible le *build once, deploy many* : une valeur propre à un environnement figée dans l'image (un
secret, une URL de base, `APP_ENV=production` dans le Dockerfile). Il faudrait reconstruire une image par
environnement, et la production ne recevrait plus l'image testée en staging.

### 3. Qu'est-ce qui distingue l'image qui tourne de celle que le pipeline produira pour le même commit ?

L'image qui tourne, je l'ai construite à la main sur mon poste et personne ne l'a scannée : rien ne garantit qu'elle
serait identique sur une autre machine. Celle du pipeline sera construite sur un runner neutre et reproductible,
scannée par Trivy (bloquée en cas de faille CRITICAL), puis publiée sur ghcr.io. C'est le même commit, mais ce n'est
pas le même niveau de confiance.

## Partie B. Pipeline de release

### Lead time mesuré (B.6)

| Jalon | Heure |
|---|---|
| Merge de la PR #7 | 15:55:10 |
| Fin de `deploy-staging` | 15:56:31 |
| Approbation | 15:57:23 |
| Fin de `deploy-production` | 15:57:47 |

Lead time for changes : 2 min 37 s du merge à la production, dont 52 s d'attente de mon approbation. Il faudrait y
ajouter le temps de revue de la PR pour avoir le vrai chiffre.

### 1. Retirer les *required reviewers* de `production`

Rien ne change dans le YAML : la protection est portée par l'environment GitHub, pas par le workflow. On passe de la
livraison continue au déploiement continu : chaque merge sur `main` part en production sans personne pour l'arrêter.
Côté équipe, la responsabilité se déplace sur la revue de la PR, qui devient la dernière barrière humaine. Avant de
franchir ce pas, il faut des tests automatisés qui couvrent vraiment le métier, un monitoring avec alertes pour voir
un problème avant les utilisateurs, et un rollback automatique fiable (smoke test et retour à `.previous_tag`).

### 2. Publier après le scan, et `:latest`

Si je publiais avant le scan, une image vulnérable serait déjà dans le registre et pourrait être tirée par quelqu'un
avant que le scan échoue. Publier après le scan garantit que tout ce qui est sur ghcr.io a passé le contrôle, et je
pousse l'image scannée elle-même, pas une reconstruction. `:latest` est dangereux pour déployer parce qu'il bouge : on
ne sait pas quelle version tourne, deux serveurs peuvent avoir deux `:latest` différents, et un rollback vers
`:latest` ne veut rien dire. On le publie quand même par commodité (essai rapide, `docker pull` sans connaître le SHA),
mais on déploie toujours par SHA.

### 3. Pourquoi `images` tourne chez GitHub et pas sur le runner self-hosted

Le build et le scan n'ont pas besoin d'accéder à mes serveurs : ils tournent sur une machine neutre, jetable et
identique à chaque run, sans le socket Docker de mon poste. Le runner self-hosted a l'équivalent d'un accès root à ma
machine : je limite ce qu'il exécute au strict nécessaire, le déploiement. En plus, le build ne consomme pas les
ressources de mon poste, et il marche même si mon runner est éteint.

### 4. Ce qu'un job peut laisser au suivant sur un runner persistant

- Les identifiants `docker login` dans `~/.docker/config.json` : `release.yml` fait `docker logout` dans un step
  `if: always()`.
- Les fichiers du workspace (`work/`), les images et conteneurs Docker : chaque job refait un `checkout` propre, avec
  `persist-credentials: false` pour ne pas laisser le jeton Git dans `.git/config`.

## Partie C. Rollback et Dependabot

### Question C.1 : comment savoir qu'un nouveau SHA proposé par Dependabot est légitime ?

Honnêtement, on ne peut pas en être sûr à 100 %. Ce que je ferais : aller voir sur le dépôt de l'action que le SHA
correspond bien au tag de la release (et si possible que le tag est signé), lire vite fait les release notes pour voir
si rien de bizarre n'a changé, et surtout ne pas fusionner tout de suite, attendre quelques jours. Si l'action a été
piratée (comme tj-actions en 2025), ça finit souvent par se savoir rapidement. Les releases immuables de GitHub
aident aussi, puisqu'un tag ne peut plus être déplacé après coup.

### Question C.5 : pourquoi laisser le job rouge alors que le service est rétabli ?

J'ai forcé `c945a6e` en prod : le smoke test a planté, le rollback est revenu tout seul sur `4d0d736` en quelques
secondes, mais le job est resté rouge. Et c'est voulu. Pour moi, un job vert voudrait dire « tout s'est bien passé »,
alors que la prod a quand même été cassée un moment. Si c'est vert, personne ne regarde, et on ne cherche jamais
pourquoi c'est arrivé. Rouge, ça oblige à aller voir, à comprendre, et à corriger la cause (le post-mortem du jour 4).

## Débrief

### Où passe le temps du lead time, et le déploiement continu ?

Sur mes 2 min 37, presque une minute, c'est moi qui n'ai pas encore cliqué sur « approuver ». Le reste, c'est surtout
le build et le scan des images, puis le déploiement sur le staging. Et en vrai, dans une équipe, le gros du temps
serait plutôt dans la revue de PR, avant le merge, donc ça ne se voit pas dans ce chiffre. Passer au déploiement
continu enlèverait l'attente de l'approbation, mais ça a un coût : il faut des tests assez solides pour leur faire
confiance, un monitoring qui alerte vite, et accepter que plus personne ne vérifie avant la prod.

### Les métriques DORA

Le pipeline aide directement sur la fréquence de déploiement et le lead time, puisque tout est automatique depuis le
merge. Il aide aussi le temps de restauration : un rollback par tag prend une ou deux minutes, et même quelques secondes
avec le rollback automatique, comme on l'a vu en C.5. Avec le monitoring du jour 4, on mesurera surtout ce temps de
restauration (combien de temps entre le moment où ça casse et le moment où c'est réparé), et un peu le taux d'échec des
changements.

### Qu'est-ce qui est « sécurité » dans ce pipeline ?

Pas mal de choses en fait :
- le scan Trivy, qui bloque une image avec une faille critique avant qu'elle soit publiée ;
- `permissions: {}` puis juste les droits nécessaires job par job ;
- les actions épinglées par SHA plutôt que par tag ;
- le tag de rollback validé, et les inputs passés par `env` pour éviter l'injection ;
- les secrets dans les `.env` du serveur (en 600) et pas dans Git, avec gitleaks en pre-commit pour être sûr ;
- le `docker logout` à la fin, pour ne rien laisser traîner sur le runner ;
- l'approbation obligatoire et la restriction à `main` pour l'environment `production` ;
- Dependabot pour garder les dépendances et les actions à jour.
