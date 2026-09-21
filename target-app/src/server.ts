import express from "express";
import { loadConfig, type Config } from "./config.js";
import { configureSession } from "./session.js";
import { createAuthRouter } from "./routes/auth.js";
import { createSearchRouter } from "./routes/search.js";
import { createMemberRouter } from "./routes/member.js";
import { createSubAccountRouter } from "./routes/subAccount.js";

export function createApp(config: Config): express.Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  configureSession(app, config);
  app.use(createAuthRouter(config));
  app.use(createSearchRouter(config));
  app.use(createMemberRouter(config));
  app.use(createSubAccountRouter(config));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createApp(config).listen(config.port, () => {
    console.log(`target-app listening on http://localhost:${config.port}`);
  });
}
