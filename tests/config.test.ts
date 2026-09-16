import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("durable worker configuration", () => {
  it("uses conservative worker defaults for local development", () => {
    const config = loadConfig({}, process.cwd());

    expect(config.WORKER_POLL_INTERVAL_MS).toBe(1_000);
    expect(config.WORKER_BATCH_SIZE).toBe(8);
    expect(config.WORKER_LEASE_MS).toBe(300_000);
    expect(config.WORKER_MAX_ATTEMPTS).toBe(6);
  });

  it("requires encryption keys whenever PostgreSQL durability is enabled", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/test" })).toThrow(
      /QUEUE_ENCRYPTION_KEYS/,
    );
  });

  it("rejects unsafe lease and inconsistent backoff settings", () => {
    expect(() => loadConfig({ WORKER_LEASE_MS: "30000" })).toThrow();
    expect(() =>
      loadConfig({ WORKER_RETRY_BASE_MS: "5000", WORKER_RETRY_MAX_MS: "1000" }),
    ).toThrow(/WORKER_RETRY_MAX_MS/);
  });
});
