import { describe, expect, it } from "vitest";
import { loggedInAgent } from "./helpers.js";

describe("search form validation", () => {
  it("empty search input re-renders the search page with a role=alert message instead of redirecting", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.post("/search").type("form").send({ memberId: "   " });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<p role="alert">Invalid Input: Member ID is required.</p>');
  });
});
