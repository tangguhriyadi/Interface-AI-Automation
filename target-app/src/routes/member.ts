import { Router } from "express";
import type { Config } from "../config.js";
import { getMember } from "../data/memberStore.js";
import { resolveBehavior } from "../failureInjection.js";
import { createRequireAuth, dismissInterstitial, hasDismissedInterstitial } from "../session.js";
import { renderBalancePanel } from "../views/balancePanel.js";
import { renderInterstitialPage } from "../views/interstitial.js";
import { renderMemberDetailPage } from "../views/memberDetailPage.js";
import { renderMessagePage } from "../views/messagePage.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderAccessDenied(memberId: string): string {
  return renderMessagePage({
    title: "Access Denied",
    message: `Access to member ${memberId} is restricted.`,
  });
}

function renderServerError(): string {
  return renderMessagePage({
    title: "Server Error",
    message: "Something went wrong while retrieving this member. Please try again.",
  });
}

/**
 * Owns every failure-injection branch for a member lookup, keyed by ID
 * (see failureInjection.ts). This is the single place that decides
 * business-outcome vs. hard-failure vs. recoverable-interstitial vs. normal,
 * so search and any other entry point just redirect here.
 */
export function createMemberRouter(config: Config): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.get("/members/:memberId", requireAuth, async (req, res) => {
    const memberIdParam = req.params.memberId ?? "";
    const behavior = resolveBehavior(memberIdParam);

    if (behavior === "invalid_input") {
      res
        .status(200)
        .send(renderMessagePage({ title: "Invalid Input", message: "Member ID must contain only digits." }));
      return;
    }

    if (behavior === "not_found") {
      res
        .status(200)
        .send(renderMessagePage({ title: "Member Not Found", message: `No member matches ID ${memberIdParam}.` }));
      return;
    }

    if (behavior === "access_denied") {
      res.status(200).send(renderAccessDenied(memberIdParam));
      return;
    }

    if (behavior === "server_error") {
      res.status(500).send(renderServerError());
      return;
    }

    if (behavior === "maintenance_interstitial" && !hasDismissedInterstitial(req.session, memberIdParam)) {
      res
        .status(200)
        .send(
          renderInterstitialPage({
            dismissAction: `/members/${encodeURIComponent(memberIdParam)}/dismiss-interstitial`,
          }),
        );
      return;
    }

    if (behavior === "slow_load") {
      await delay(config.slowLoadMs);
    }

    const member = getMember(memberIdParam.trim());
    if (!member) {
      res
        .status(200)
        .send(renderMessagePage({ title: "Member Not Found", message: `No member matches ID ${memberIdParam}.` }));
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
    const behavior = resolveBehavior(memberIdParam);

    if (behavior === "access_denied") {
      res.status(200).send(renderAccessDenied(memberIdParam));
      return;
    }

    if (behavior === "server_error") {
      res.status(500).send(renderServerError());
      return;
    }

    const member = getMember(memberIdParam.trim());
    if (!member) {
      res.status(200).send(renderMessagePage({ title: "Member Not Found", message: "No balance data available." }));
      return;
    }
    res.status(200).send(renderBalancePanel({ accounts: member.accounts }));
  });

  return router;
}
