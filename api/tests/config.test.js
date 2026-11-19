import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('readConfig', () => {
  it("utilise les valeurs par défaut quand aucune variable n'est définie", () => {
    expect(readConfig({})).toEqual({
      port: 3000,
      databaseUrl: 'postgres://taskflow:taskflow@localhost:5432/taskflow',
      appEnv: 'local',
      appVersion: 'dev',
    });
  });

  describe('en production', () => {
    it('refuse de démarrer sans DATABASE_URL', () => {
      expect(() => readConfig({ APP_ENV: 'production' })).toThrow(
        /DATABASE_URL manquante en production/,
      );
    });

    it('refuse la coquille DATABASE_UR (incident n° 1)', () => {
      expect(() =>
        readConfig({ APP_ENV: 'production', DATABASE_UR: 'postgres://x@db/x' }),
      ).toThrow(/DATABASE_URL/);
    });

    it('refuse une DATABASE_URL vide', () => {
      expect(() =>
        readConfig({ APP_ENV: 'production', DATABASE_URL: '' }),
      ).toThrow(/DATABASE_URL/);
    });
  });

  it('refuse aussi de démarrer sans DATABASE_URL en staging', () => {
    expect(() => readConfig({ APP_ENV: 'staging' })).toThrow(
      /DATABASE_URL manquante en staging/,
    );
  });

  it('garde le défaut localhost en local', () => {
    expect(readConfig({}).databaseUrl).toBe(
      'postgres://taskflow:taskflow@localhost:5432/taskflow',
    );
  });

  it("lit les variables d'environnement fournies", () => {
    const config = readConfig({
      PORT: '4000',
      DATABASE_URL: 'postgres://u:p@db:5432/x',
      APP_ENV: 'production',
      APP_VERSION: 'abc1234',
    });

    expect(config).toEqual({
      port: 4000,
      databaseUrl: 'postgres://u:p@db:5432/x',
      appEnv: 'production',
      appVersion: 'abc1234',
    });
  });
});
