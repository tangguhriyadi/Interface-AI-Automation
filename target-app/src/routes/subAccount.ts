import express, { Router } from "express";
import type { Response } from "express";
import type { Config } from "../config.js";
import { addSubAccount, getMember, type Member } from "../data/memberStore.js";
import { formatMoney } from "../money.js";
import {
  consumePendingSubAccountToken,
  createRequireAuth,
  issuePendingSubAccountToken,
} from "../session.js";
import { isValidSubAccountType, subAccountTypeLabel } from "../subAccountTypes.js";
import { checkFailureInjection, renderNotFound } from "./memberLookup.js";
import { renderMessagePage } from "../views/messagePage.js";
import { renderSubAccountConfirmPage } from "../views/subAccountConfirmPage.js";
import { renderSubAccountNewPage } from "../views/subAccountNewPage.js";
import { renderSubAccountReviewPage } from "../views/subAccountReviewPage.js";

const MIN_INITIAL_DEPOSIT_CENTS = 2_500; // $25.00
const MAX_INITIAL_DEPOSIT_CENTS = 100_000_000; // $1,000,000.00

/** Accepts a dollar amount with up to 2 decimal places, e.g. "500" or "500.00"; null if malformed. */
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  return Math.round(Number(trimmed) * 100);
}

function isWithinDepositLimits(cents: number): boolean {
  return cents >= MIN_INITIAL_DEPOSIT_CENTS && cents <= MAX_INITIAL_DEPOSIT_CENTS;
}

function depositLimitMessage(): string {
  return `Initial deposit must be between ${formatMoney(MIN_INITIAL_DEPOSIT_CENTS)} and ${formatMoney(MAX_INITIAL_DEPOSIT_CENTS)}.`;
}

/**
 * Resolves a member ID the same way every other route does (see
 * memberLookup.ts) and sends the appropriate response itself when the ID
 * doesn't resolve to a real member, so every call site just checks for a
 * non-null return.
 */
function resolveMemberOrRespond(memberIdParam: string, res: Response): Member | null {
  const check = checkFailureInjection(memberIdParam);
  if (check.outcome === "render") {
    res.status(check.status).send(check.body);
    return null;
  }
  const member = getMember(memberIdParam.trim());
  if (!member) {
    res.status(200).send(renderNotFound(memberIdParam));
    return null;
  }
  return member;
}

export function createSubAccountRouter(config: Config): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  const requireAuth = createRequireAuth(config);

  router.get("/members/:memberId/sub-account/new", requireAuth, (req, res) => {
    const memberId = req.params.memberId ?? "";
    if (!resolveMemberOrRespond(memberId, res)) {
      return;
    }

    const accountType = typeof req.query.accountType === "string" ? req.query.accountType : "";
    const initialDeposit = typeof req.query.initialDeposit === "string" ? req.query.initialDeposit : "";
    const termsAccepted = req.query.termsAccepted === "on";

    res.status(200).send(renderSubAccountNewPage({ memberId, accountType, initialDeposit, termsAccepted }));
  });

  router.post("/members/:memberId/sub-account/review", requireAuth, (req, res) => {
    const memberId = req.params.memberId ?? "";
    if (!resolveMemberOrRespond(memberId, res)) {
      return;
    }

    const accountType = typeof req.body.accountType === "string" ? req.body.accountType : "";
    const initialDeposit = typeof req.body.initialDeposit === "string" ? req.body.initialDeposit : "";
    const termsAccepted = req.body.termsAccepted === "on";

    if (!isValidSubAccountType(accountType)) {
      res
        .status(200)
        .send(
          renderSubAccountNewPage({
            memberId,
            accountType,
            initialDeposit,
            termsAccepted,
            error: "Select a valid account type.",
          }),
        );
      return;
    }

    const cents = parseDollarsToCents(initialDeposit);
    if (cents === null) {
      res
        .status(200)
        .send(
          renderSubAccountNewPage({
            memberId,
            accountType,
            initialDeposit,
            termsAccepted,
            error: "Initial deposit must be a non-negative dollar amount, e.g. 500.00.",
          }),
        );
      return;
    }

    if (!isWithinDepositLimits(cents)) {
      res
        .status(200)
        .send(
          renderSubAccountNewPage({
            memberId,
            accountType,
            initialDeposit,
            termsAccepted,
            error: depositLimitMessage(),
          }),
        );
      return;
    }

    if (!termsAccepted) {
      res
        .status(200)
        .send(
          renderSubAccountNewPage({
            memberId,
            accountType,
            initialDeposit,
            termsAccepted,
            error: "You must accept the terms and conditions to continue.",
          }),
        );
      return;
    }

    const token = issuePendingSubAccountToken(req.session);
    res.status(200).send(
      renderSubAccountReviewPage({
        memberId,
        accountTypeValue: accountType,
        accountTypeLabel: subAccountTypeLabel(accountType),
        initialDepositRaw: initialDeposit,
        initialDepositFormatted: formatMoney(cents),
        termsAccepted,
        token,
      }),
    );
  });

  router.post("/members/:memberId/sub-account/confirm", requireAuth, (req, res) => {
    const memberId = req.params.memberId ?? "";
    const member = resolveMemberOrRespond(memberId, res);
    if (!member) {
      return;
    }

    const submittedToken = typeof req.body.token === "string" ? req.body.token : "";
    if (!consumePendingSubAccountToken(req.session, submittedToken)) {
      res
        .status(200)
        .send(
          renderMessagePage({
            title: "Duplicate Submission",
            message: "This sub-account request has already been submitted or is no longer valid. Please start again.",
          }),
        );
      return;
    }

    const accountType = typeof req.body.accountType === "string" ? req.body.accountType : "";
    const initialDeposit = typeof req.body.initialDeposit === "string" ? req.body.initialDeposit : "";
    const termsAccepted = req.body.termsAccepted === "on";
    const cents = parseDollarsToCents(initialDeposit);

    if (!isValidSubAccountType(accountType) || cents === null || !isWithinDepositLimits(cents) || !termsAccepted) {
      res
        .status(200)
        .send(
          renderSubAccountNewPage({
            memberId,
            accountType,
            initialDeposit,
            termsAccepted,
            error: "Submission was invalid. Please review and try again.",
          }),
        );
      return;
    }

    const subAccount = addSubAccount(member.memberId, accountType, cents);
    res.redirect(
      `/members/${encodeURIComponent(member.memberId)}/sub-account/${encodeURIComponent(subAccount.id)}/created`,
    );
  });

  router.get("/members/:memberId/sub-account/:subAccountId/created", requireAuth, (req, res) => {
    const memberId = req.params.memberId ?? "";
    const subAccountId = req.params.subAccountId ?? "";
    const member = resolveMemberOrRespond(memberId, res);
    if (!member) {
      return;
    }

    const subAccount = member.subAccounts.find((candidate) => candidate.id === subAccountId);
    if (!subAccount) {
      res
        .status(200)
        .send(
          renderMessagePage({
            title: "Sub-Account Not Found",
            message: `No sub-account ${subAccountId} was found for member ${memberId}.`,
          }),
        );
      return;
    }

    res.status(200).send(
      renderSubAccountConfirmPage({
        memberId: member.memberId,
        subAccountId: subAccount.id,
        accountTypeLabel: subAccountTypeLabel(subAccount.accountType),
        initialDepositFormatted: formatMoney(subAccount.initialDepositCents),
      }),
    );
  });

  return router;
}
