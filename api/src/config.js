// Lecture de la configuration depuis les variables d'environnement.
// Une seule fonction, pure : on lui donne un objet env, elle renvoie la config.

const DEFAULT_PORT = 3000;
const DEPLOYED_ENVS = ['staging', 'production'];
const DEFAULT_DATABASE_URL =
  'postgres://taskflow:taskflow@localhost:5432/taskflow';

export function readConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'local';
  // Le défaut localhost n'a aucun sens dans un conteneur déployé.
  if (DEPLOYED_ENVS.includes(appEnv) && !env.DATABASE_URL) {
    throw new Error(`DATABASE_URL manquante en ${appEnv}`);
  }

  return Object.freeze({
    port: Number(env.PORT) || DEFAULT_PORT,
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
    appEnv,
    appVersion: env.APP_VERSION || 'dev',
  });
}
