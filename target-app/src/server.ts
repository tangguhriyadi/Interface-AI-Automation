import express from "express";

export function createApp(): express.Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4000);
  createApp().listen(port, () => {
    console.log(`target-app listening on http://localhost:${port}`);
  });
}
