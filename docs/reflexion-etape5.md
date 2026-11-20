# Étape 5 : questions de réflexion

Le détail du triage, des corrections et des exceptions est dans `docs/SECURITE.md`.

### 1. Quelle faille de Juice Shop la baseline n'aurait-elle pas vue ?

Le Login Admin (l'injection SQL `' OR 1=1--` dans le champ e-mail). La baseline est passive : elle explore le site
et regarde les réponses (en-têtes, cookies, fuites), mais elle n'envoie jamais de charge d'attaque. Elle ne tente
donc aucune injection. Même chose pour la XSS DOM et pour l'IDOR du panier : pour voir l'IDOR, il faut savoir que le
panier 1 n'est pas à moi, et ça, aucun scanner ne le sait.

Pour la détecter dans un pipeline :
- le SAST à la PR (Semgrep `p/nodejsscan`, règle `node_sqli_injection`), qui voit la concaténation dans le code avant
  même que ça tourne ;
- un scan ZAP actif (`zap-full-scan.py`) ou sqlmap, mais pas à chaque PR parce que c'est long et agressif : plutôt
  planifié la nuit sur le staging ;
- et pour l'IDOR, des tests d'autorisation (l'utilisateur A demande la ressource de B, on attend un 404).

### 2. Une faille critical dans `vitest`, c'est exploitable en prod ?

Non. `vitest` est une devDependency : l'image de l'API fait `npm ci --omit=dev`, donc il n'est même pas installé en
prod, et le front en prod n'est que des fichiers statiques servis par Nginx. Je l'ai vérifié sur notre cas : les
3 critical de l'API venaient toutes de `vitest` 2 et de sa chaîne (`tinypool`, `vite`, `esbuild`...).

Mais je l'ai corrigée quand même (montée en Vitest 5), pour trois raisons :
- ce code tourne bel et bien, dans la CI et sur nos postes, et la CI a accès à des choses sensibles (jeton GitHub,
  publication des images sur GHCR) : une dépendance de test compromise, c'est une attaque de la chaîne de build ;
- si on laisse `npm audit` rouge en permanence, tout le monde apprend à ignorer le check, et le jour où une vraie
  faille arrive dans `express` ou `pg`, personne ne la voit ;
- plus on attend, plus la montée est grosse (là c'était 2 → 5, avec Node 20 à retirer de la CI au passage).

### 3. Pourquoi masquer `X-Powered-By` et `Server` ?

Honnêtement, ça n'empêche aucune attaque : si Nginx a une faille, elle est là avec ou sans l'en-tête. Mais
`Server: nginx/1.31.9` ou `X-Powered-By: Express` disent à un attaquant quelle techno et quelle version chercher dans
les bases de CVE, et les robots qui scannent Internet trient leurs cibles comme ça. Sans ces en-têtes, il doit
tâtonner, il fait plus de bruit et on a plus de chances de le voir passer dans les logs.

C'est de la défense en profondeur : ça coûte une ligne de config, ça n'a aucun inconvénient, donc il n'y a pas de
raison de donner l'info gratuitement. Par contre ça ne remplace pas les mises à jour, c'est en plus.

### 4. Un collègue met toutes les règles ZAP en IGNORE pour passer au vert

Le job est vert mais il ne vérifie plus rien. C'est pire que pas de scan du tout, parce que tout le monde croit être
protégé. Les vraies failles qu'on aurait dû corriger (CSP absente, clickjacking) restent, et le jour où quelqu'un
supprime un en-tête par erreur, rien ne le signale.

Ce que je propose à la place :
- trier chaque alerte : vrai positif, on corrige ; faux positif, on l'ignore, mais règle par règle ;
- chaque IGNORE a une justification, un auteur, une date et une date de revue dans le registre de `SECURITE.md` ;
- passer en FAIL les règles qu'on a corrigées, pour que toute régression bloque la PR (c'est ce que j'ai fait pour
  la CSP, nosniff, X-Frame-Options, Permissions-Policy, `Server` et `X-Powered-By`) ;
- et faire relire toute modification de `.zap/rules.tsv` en PR, comme du code (un CODEOWNERS dessus, ce serait encore
  mieux).

Si le job est rouge et qu'on n'a pas le temps, on ouvre une issue et on note une exception datée, mais on ne
désactive pas le contrôle en silence.

### 5. Pourquoi `security.yml` chaque semaine alors que `ci.yml` tourne déjà à chaque PR ?

Parce que `ci.yml` ne tourne que quand quelqu'un pousse du code. Si personne ne touche au dépôt pendant un mois, une
CVE publiée entre-temps sur `express` ou sur l'image de base ne sera vue par personne. Le code n'a pas changé, mais
le risque, si : la base de vulnérabilités, elle, bouge tous les jours.

Le scan du lundi relance `npm audit` avec la base à jour, gitleaks avec ses nouvelles règles, et ZAP sur la version
actuelle. Une dépendance qui était saine au moment du merge peut devenir vulnérable la semaine suivante : c'est
comme ça qu'on le voit sans attendre la prochaine PR. C'est ce que le cours appelle le shift-right, et c'est
complémentaire de Dependabot, qui propose la mise à jour mais ne fait pas échouer quoi que ce soit.
