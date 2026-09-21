import { describe, expect, it } from "vitest";
import { loggedInAgent } from "./helpers.js";

describe("TENANT label overlay", () => {
  it("default tenant shows Member ID / Search", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/search");
    expect(res.text).toContain(">Member ID<");
    expect(res.text).toContain(">Search<");
  });

  it("beta tenant renames labels to Account Number / Find", async () => {
    const { agent } = await loggedInAgent({ TENANT: "beta" });
    const res = await agent.get("/search");
    expect(res.text).toContain(">Account Number<");
    expect(res.text).toContain(">Find<");
  });
});
