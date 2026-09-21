import { describe, expect, it } from "vitest";
import { loggedInAgent } from "./helpers.js";

describe("failure injection behaviors", () => {
  it("normal (10001): renders the member detail page", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/10001");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Elena Cho");
  });

  it("not_found (99999): renders Member Not Found", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/99999");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Member Not Found");
  });

  it("access_denied (10002): renders Access Denied", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/10002");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Access Denied");
  });

  it("maintenance_interstitial (10003): shows the interstitial, then real content once dismissed", async () => {
    const { agent } = await loggedInAgent();

    const beforeDismiss = await agent.get("/members/10003");
    expect(beforeDismiss.text).toContain("System Maintenance");

    await agent.post("/members/10003/dismiss-interstitial");

    const afterDismiss = await agent.get("/members/10003");
    expect(afterDismiss.status).toBe(200);
    expect(afterDismiss.text).toContain("Dana Okafor");
    expect(afterDismiss.text).not.toContain("System Maintenance");
  });

  it("slow_load (10004): delays by SLOW_LOAD_MS, then renders real content", async () => {
    const { agent, config } = await loggedInAgent();
    const start = Date.now();
    const res = await agent.get("/members/10004");
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(config.slowLoadMs);
    expect(res.text).toContain("Sam Delacroix");
  });

  it("server_error (10005): renders a 500 Server Error page", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/10005");
    expect(res.status).toBe(500);
    expect(res.text).toContain("Server Error");
  });

  it("invalid_input (non-numeric): renders Invalid Input", async () => {
    const { agent } = await loggedInAgent();
    const res = await agent.get("/members/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Invalid Input");
  });
});
