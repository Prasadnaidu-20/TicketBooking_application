import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("Fastify application", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 from the liveness endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
    });
  });

  it("preserves an incoming request ID", async () => {
    const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: {
        "x-request-id": "test-request-123",
        },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("test-request-123");
  });

  it("generates and returns a request ID when one is not provided", async () => {
    const response = await app.inject({
        method: "GET",
        url: "/health/live",
    });

    expect(response.statusCode).toBe(200);

    const requestId = response.headers["x-request-id"];

    expect(requestId).toEqual(expect.any(String));
    expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});