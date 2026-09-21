import express, { Router } from "express";
import type { Config } from "../config.js";
import { createRequireAuth } from "../session.js";
import { getTenantLabels } from "../tenantLabels.js";
import { renderSearchPage } from "../views/searchPage.js";

export function createSearchRouter(config: Config): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  const requireAuth = createRequireAuth(config);
  const labels = getTenantLabels(config.tenant);

  router.get("/search", requireAuth, (_req, res) => {
    res.status(200).send(renderSearchPage({ labels }));
  });

  router.post("/search", requireAuth, (req, res) => {
    const memberIdRaw = typeof req.body.memberId === "string" ? req.body.memberId : "";
    const trimmed = memberIdRaw.trim();

    if (trimmed === "") {
      res.status(200).send(renderSearchPage({ labels, error: "Invalid Input: Member ID is required." }));
      return;
    }

    res.redirect(`/members/${encodeURIComponent(trimmed)}`);
  });

  return router;
}
