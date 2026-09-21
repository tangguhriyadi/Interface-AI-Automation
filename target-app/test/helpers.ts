import express from "express";
import request from "supertest";
import { loadConfig, type Config } from "../src/config.js";
import { configureSession } from "../src/session.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { createSearchRouter } from "../src/routes/search.js";
import { createMemberRouter } from "../src/routes/member.js";
import { createSubAccountRouter } from "../src/routes/subAccount.js";

const TEST_USERNAME = "teller";
const TEST_PASSWORD = "secret123";

export function buildApp(overrides: NodeJS.ProcessEnv = {}): { app: express.Express; config: Config } {
  const config = loadConfig({
    TARGET_APP_USERNAME: TEST_USERNAME,
    TARGET_APP_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: "test-secret",
    SLOW_LOAD_MS: "20",
    ...overrides,
  });

  const app = express();
  configureSession(app, config);
  app.use(createAuthRouter(config));
  app.use(createSearchRouter(config));
  app.use(createMemberRouter(config));
  app.use(createSubAccountRouter(config));

  return { app, config };
}

export async function loggedInAgent(
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ agent: ReturnType<typeof request.agent>; config: Config }> {
  const { app, config } = buildApp(overrides);
  const agent = request.agent(app);
  await agent.post("/login").type("form").send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  return { agent, config };
}
