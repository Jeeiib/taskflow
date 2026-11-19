# Étape 3 : questions de réflexion

## Parties A et B. Le staging en code et sa migration

### 1. Le mot de passe dans le state

Il y est, en clair : `grep POSTGRES_PASSWORD ~/taskflow-staging/terraform.tfstate` le trouve dans l'`env` du conteneur
`db` (et aussi dans la `DATABASE_URL` de l'API). Le `sensitive = true` le masque à l'affichage du plan, pas dans le
state. Donc le state, c'est un secret à part entière : jamais dans Git (d'où le `.gitignore` et le backend dont le
chemin est donné à l'`init`), et des droits serrés sur le fichier. Le mien était en 644 après l'apply, je l'ai passé en
600. En équipe, il irait dans un backend distant chiffré avec des accès restreints.

### 2. Pourquoi `tofu import` plutôt qu'un volume neuf ?

Le volume `taskflow-staging-pgdata` existait déjà avec les données dedans. Sans l'import, Tofu ne le connaît pas : il
aurait essayé de créer un volume du même nom. Soit ça plantait sur le conflit, soit (si on avait supprimé l'ancien pour
débloquer) on repartait sur une base vide, et la tâche « créée avant la migration » disparaissait. L'import inscrit
l'existant dans le state sans le toucher.

Et même avec l'import, le premier plan voulait quand même le recréer (`labels # forces replacement`, à cause des labels
`com.docker.compose.*` posés par Compose). J'ai ajouté `lifecycle { ignore_changes = [labels] }` sur le volume avant
d'appliquer. Honnêtement c'est le moment où il fallait vraiment lire le plan : `1 to destroy` sur un volume de base de
données, c'est non.

### 3. Pourquoi l'alias réseau `api` ?

Le front ne connaît pas le nom du conteneur, il appelle `http://api:3000` (c'est écrit dans `front/nginx.conf`). Avec
Compose, le nom du service (`api`) devenait automatiquement un nom DNS sur le réseau. Avec Tofu, le conteneur s'appelle
`taskflow-staging-api` et rien d'autre : sans l'alias, Nginx ne résout pas `api` et toutes les requêtes `/api` tombent
en 502. Même chose pour `db`, que l'API attend dans sa `DATABASE_URL`.

### 4. Qu'apporte Tofu par rapport à Compose ? Qu'est-ce qu'on perd ?

Ce qu'on gagne : un **plan** avant chaque changement (on voit `-/+` ou `destroy` avant que ça arrive, ce que Compose ne
montre jamais), un **state** qui permet de détecter la dérive, des variables validées, et surtout un outil qui sait
gérer bien plus que des conteneurs (DNS, cloud, bases managées...) avec le même workflow.

Ce qu'on perd : la simplicité. Un `compose.staging.yaml` de 60 lignes devient 5 fichiers, il faut gérer un state (et
le protéger), et des trucs automatiques avec Compose deviennent manuels (les alias DNS, les healthchecks à répéter pour
le `wait`). Et pour le dev en local, Compose reste bien plus pratique.
