import express, { Router } from "express";
import type { Config } from "../config.js";
import { renderLoginPage } from "../views/loginPage.js";

export function createAuthRouter(config: Config): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (req, res) => {
    res.status(200).send(renderLoginPage({ expired: req.query.expired === "1" }));
  });

  router.post("/login", (req, res) => {
    const username = typeof req.body.username === "string" ? req.body.username : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (username === config.username && password === config.password) {
      req.session.authenticated = true;
      req.session.username = username;
      req.session.requestCount = 0;
      res.redirect("/search");
      return;
    }

    res.status(200).send(renderLoginPage({ invalidCredentials: true }));
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/login");
    });
  });

  return router;
}
