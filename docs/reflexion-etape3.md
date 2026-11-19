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

## Partie C. L'IaC dans le pipeline

### 1. Pourquoi `fmt` et `validate` sur `ubuntu-latest`, et `plan` sur le runner du lab ?

`fmt` et `validate` n'ont besoin que du code : pas de Docker, pas de state. Ils tournent très bien sur une machine
jetable de GitHub, vite, et sans rien exposer. Le `plan` c'est autre chose, il doit comparer le code au vrai staging,
et seul le runner du lab le voit (le socket Docker et le state dans `~/taskflow-staging`). Sur `ubuntu-latest`, le
plan dirait « tout à créer » à chaque PR, ça n'apprendrait rien au relecteur.

Le prix, c'est que du code de PR tourne sur une machine qui a le socket Docker, donc quasiment root sur mon poste.
C'est pour ça que `iac-plan` ne se lance jamais pour une PR qui vient d'un fork, et qu'il ne reçoit aucun secret.

Et franchement ce plan en PR m'a déjà servi : j'avais voulu tester avec un label sur le réseau, ça avait l'air
inoffensif, et le plan disait `4 to destroy` (le réseau et les trois conteneurs recréés). J'ai changé pour le `restart`
du front, qui lui passe bien en `~` (modifié sur place).

Autre surprise, pendant le test de dérive : j'ai supprimé le front à la main, mais le plan de correction voulait aussi
recréer le conteneur `db`. Le déploiement de la prod (Compose) avait tiré une version plus récente de
`postgres:16-alpine`, le tag pointait donc sur une autre image, et Tofu l'a vu. Pas de perte, le volume est resté, mais
une petite coupure de la base que je n'avais pas vu venir. J'ai épinglé l'image par son digest (`@sha256:...`) pour que
ça ne se reproduise pas : un tag qui bouge, c'est une dérive qui ne vient de personne.

### 2. Pourquoi `apply tfplan` plutôt que `apply -auto-approve` ? Pourquoi supprimer `tfplan` ?

Avec `-auto-approve`, Tofu recalcule un plan au moment de l'apply et l'applique direct. Si quelque chose a bougé entre
les deux (un autre déploiement, une dérive), on applique un plan que personne n'a vu. Avec `plan -out=tfplan` puis
`apply tfplan`, on applique exactement ce qui est affiché dans le log, et si le state a changé entre temps Tofu refuse.

On supprime `tfplan` parce que le fichier contient les valeurs sensibles en clair (le mot de passe de la base), et que
le runner est persistant : il traînerait dans le dossier de travail.

### 3. Faut-il passer la production en OpenTofu aussi ?

À terme oui, pour avoir le plan relu et la détection de dérive sur ce qui compte le plus. Mais pas n'importe comment.
Les risques sont les mêmes qu'au staging en pire : un import raté ou un `forces replacement` mal lu sur le volume, et
c'est la base de prod qui part. Je le ferais après avoir fait tourner le staging un moment en Tofu, avec une sauvegarde
fraîche juste avant, `prevent_destroy` sur le volume, et le plan relu par quelqu'un d'autre. Il y a aussi le proxy et les
certificats de la prod à décrire, c'est plus de boulot que le staging.
