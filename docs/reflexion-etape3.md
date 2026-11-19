# Étape 3 : questions de réflexion

## Parties A et B. Le staging en code et sa migration

### 1. Le mot de passe dans le state

Il y est, en clair. `grep POSTGRES_PASSWORD` le trouve dans l'`env` du conteneur `db`, et il est aussi dans la
`DATABASE_URL` de l'API. Le `sensitive = true` le cache seulement à l'affichage, pas dans le state. Donc le state il faut
le traiter comme un secret : jamais dans Git, et des droits serrés. Le mien était en 644 après l'apply, je l'ai passé en
600. En équipe je le mettrais dans un backend distant chiffré, avec peu de gens qui y ont accès.

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

Le gros plus pour moi c'est le plan : on voit ce qui va être détruit avant que ça arrive, Compose ne te dit jamais
« attention je vais recréer ta base ». Il y a aussi le state, qui permet de repérer une dérive, et les variables
validées. Et Tofu sait gérer plein d'autres choses que des conteneurs (DNS, cloud, bases managées), avec la même façon
de travailler.

Ce qu'on perd, c'est la simplicité. Le compose de 60 lignes devient 5 fichiers, il faut gérer un state et le protéger,
et des trucs que Compose faisait tout seul deviennent à ma charge (les alias DNS, les healthchecks à réécrire pour le
`wait`). Pour le dev en local, je garderais Compose sans hésiter.
