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
