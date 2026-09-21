import { describe, expect, it } from "vitest";
import { getMember } from "../src/data/memberStore.js";
import { loggedInAgent } from "./helpers.js";

type Agent = Awaited<ReturnType<typeof loggedInAgent>>["agent"];

/** Submits step 1 + step 2 and returns the one-time confirm token from the review page. */
async function reviewAndGetToken(agent: Agent, memberId: string): Promise<string> {
  const review = await agent
    .post(`/members/${memberId}/sub-account/review`)
    .type("form")
    .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on" });
  return review.text.match(/name="token" value="([^"]+)"/)?.[1] ?? "";
}

describe("sub-account happy path", () => {
  it("new -> review -> confirm creates a sub-account and lands on the success checkpoint", async () => {
    const { agent } = await loggedInAgent();
    const memberId = "10006";
    const before = getMember(memberId)!.subAccounts.length;

    const newPage = await agent.get(`/members/${memberId}/sub-account/new`);
    expect(newPage.status).toBe(200);

    const review = await agent
      .post(`/members/${memberId}/sub-account/review`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on" });
    expect(review.status).toBe(200);
    expect(review.text).toContain("Review Sub-Account");

    const token = review.text.match(/name="token" value="([^"]+)"/)?.[1] ?? "";
    expect(token).not.toBe("");

    const confirm = await agent
      .post(`/members/${memberId}/sub-account/confirm`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on", token });
    expect(confirm.status).toBe(302);
    const createdLocation = confirm.headers.location;
    expect(createdLocation).toBeDefined();

    const created = await agent.get(createdLocation!);
    expect(created.status).toBe(200);
    expect(created.text).toContain("Sub-Account Created");
    expect(created.text).toMatch(/Sub-Account ID: SA-\d{4}/);

    expect(getMember(memberId)!.subAccounts.length).toBe(before + 1);
  });
});

describe("duplicate submission", () => {
  it("resubmitting confirm with the same token shows Duplicate Submission and creates nothing further", async () => {
    const { agent } = await loggedInAgent();
    const memberId = "10007";
    const token = await reviewAndGetToken(agent, memberId);

    const firstConfirm = await agent
      .post(`/members/${memberId}/sub-account/confirm`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on", token });
    expect(firstConfirm.status).toBe(302);
    expect(getMember(memberId)!.subAccounts.length).toBe(1);

    const secondConfirm = await agent
      .post(`/members/${memberId}/sub-account/confirm`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on", token });
    expect(secondConfirm.status).toBe(200);
    expect(secondConfirm.text).toContain("Duplicate Submission");
    expect(getMember(memberId)!.subAccounts.length).toBe(1);
  });
});

describe("post-redirect-get on confirm", () => {
  it("successful confirm redirects (302) to the /created page, which shows the success checkpoint", async () => {
    const { agent } = await loggedInAgent();
    const memberId = "10008";
    const token = await reviewAndGetToken(agent, memberId);

    const confirm = await agent
      .post(`/members/${memberId}/sub-account/confirm`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "500.00", termsAccepted: "on", token });
    expect(confirm.status).toBe(302);
    const createdLocation = confirm.headers.location;
    expect(createdLocation).toBeDefined();

    const created = await agent.get(createdLocation!);
    expect(created.status).toBe(200);
    expect(created.text).toContain("Sub-Account Created");
    expect(created.text).toMatch(/Sub-Account ID: SA-\d{4}/);
  });
});

describe("deposit limits", () => {
  it("rejects 0, 24.99, and 1000000.01 with the visible limit message; accepts 25.00", async () => {
    const { agent } = await loggedInAgent();
    const memberId = "10001";
    const limitMessage = "Initial deposit must be between $25.00 and $1,000,000.00.";

    for (const amount of ["0", "24.99", "1000000.01"]) {
      const res = await agent
        .post(`/members/${memberId}/sub-account/review`)
        .type("form")
        .send({ accountType: "money-market", initialDeposit: amount, termsAccepted: "on" });
      expect(res.status).toBe(200);
      expect(res.text).toContain(limitMessage);
    }

    const accepted = await agent
      .post(`/members/${memberId}/sub-account/review`)
      .type("form")
      .send({ accountType: "money-market", initialDeposit: "25.00", termsAccepted: "on" });
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain("Review Sub-Account");
  });
});

describe("cross-route consistency", () => {
  it("10002 on the sub-account new route renders Access Denied, not Member Not Found", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/10002/sub-account/new");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Access Denied");
    expect(res.text).not.toContain("Member Not Found");
  });
});
