import { describe, expect, it } from "vitest";
import { loggedInAgent } from "./helpers.js";

describe("EXPIRE_SESSION_AFTER_REQUESTS", () => {
  it("allows exactly n protected requests, then redirects the (n+1)th to /login?expired=1", async () => {
    const { agent } = await loggedInAgent({ EXPIRE_SESSION_AFTER_REQUESTS: "2" });

    const first = await agent.get("/search");
    const second = await agent.get("/search");
    const third = await agent.get("/search");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(302);
    expect(third.headers.location).toBe("/login?expired=1");
  });

  it("pins the exact 3-tick sequence of a full UI lookup: the balance iframe's request is the one that expires, not the parent page", async () => {
    const { agent } = await loggedInAgent({ EXPIRE_SESSION_AFTER_REQUESTS: "2" });

    const searchTick1 = await agent.post("/search").type("form").send({ memberId: "10001" });
    expect(searchTick1.status).toBe(302);
    expect(searchTick1.headers.location).toBe("/members/10001");

    const detailTick2 = await agent.get("/members/10001");
    expect(detailTick2.status).toBe(200);
    expect(detailTick2.text).toContain("Elena Cho");

    const balanceTick3 = await agent.get("/members/10001/balance");
    expect(balanceTick3.status).toBe(302);
    expect(balanceTick3.headers.location).toBe("/login?expired=1");
  });
});
