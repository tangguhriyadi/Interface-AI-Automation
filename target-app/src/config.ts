export interface Config {
  port: number;
  username: string;
  password: string;
  sessionSecret: string;
  tenant: string;
  expireSessionAfterRequests: number;
  slowLoadMs: number;
}

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNonNegativeNumber(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid environment variable ${name}: expected a non-negative number, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseNonNegativeNumber(env, "PORT", 4000),
    username: requireString(env, "TARGET_APP_USERNAME"),
    password: requireString(env, "TARGET_APP_PASSWORD"),
    sessionSecret: requireString(env, "SESSION_SECRET"),
    tenant: env.TENANT ?? "default",
    expireSessionAfterRequests: parseNonNegativeNumber(env, "EXPIRE_SESSION_AFTER_REQUESTS", 0),
    slowLoadMs: parseNonNegativeNumber(env, "SLOW_LOAD_MS", 6000),
  };
}
