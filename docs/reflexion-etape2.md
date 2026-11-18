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
