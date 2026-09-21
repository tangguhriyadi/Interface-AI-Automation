import { Router } from "express";
import type { Config } from "../config.js";
import { getMember } from "../data/memberStore.js";
import { checkFailureInjection, renderNotFound } from "./memberLookup.js";
import { createRequireAuth, dismissInterstitial, hasDismissedInterstitial } from "../session.js";
import { renderBalancePanel } from "../views/balancePanel.js";
import { renderInterstitialPage } from "../views/interstitial.js";
import { renderMemberDetailPage } from "../views/memberDetailPage.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handles the recoverable-in-place conditions (interstitial, slow load) and
 * the final fixture lookup for a member lookup. The deterministic
 * invalid/denied/error/not-found outcomes are owned by memberLookup.ts so
 * every route that resolves a member ID reaches the same outcome.
 */
export function createMemberRouter(config: Config): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.get("/members/:memberId", requireAuth, async (req, res) => {
    const memberIdParam = req.params.memberId ?? "";
    const check = checkFailureInjection(memberIdParam);

    if (check.outcome === "render") {
      res.status(check.status).send(check.body);
      return;
    }

    if (check.behavior === "maintenance_interstitial" && !hasDismissedInterstitial(req.session, memberIdParam)) {
      res
        .status(200)
        .send(
          renderInterstitialPage({
            dismissAction: `/members/${encodeURIComponent(memberIdParam)}/dismiss-interstitial`,
          }),
        );
      return;
    }

    if (check.behavior === "slow_load") {
      await delay(config.slowLoadMs);
    }

    const member = getMember(memberIdParam.trim());
    if (!member) {
      res.status(200).send(renderNotFound(memberIdParam));
      return;
    }

    res.status(200).send(renderMemberDetailPage({ member }));
  });

  router.post("/members/:memberId/dismiss-interstitial", requireAuth, (req, res) => {
    const memberIdParam = req.params.memberId ?? "";
    dismissInterstitial(req.session, memberIdParam);
    res.redirect(`/members/${encodeURIComponent(memberIdParam)}`);
  });

  router.get("/members/:memberId/balance", requireAuth, (req, res) => {
    const memberIdParam = req.params.memberId ?? "";
    const check = checkFailureInjection(memberIdParam);

    if (check.outcome === "render") {
      res.status(check.status).send(check.body);
      return;
    }

    const member = getMember(memberIdParam.trim());
    if (!member) {
      res.status(200).send(renderNotFound(memberIdParam));
      return;
    }
    res.status(200).send(renderBalancePanel({ accounts: member.accounts }));
  });

  return router;
}
