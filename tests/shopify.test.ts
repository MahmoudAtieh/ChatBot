import { describe, expect, it } from "vitest";
import { buildShopifySearchQuery, ShopifyCatalog } from "../src/shopify.js";

describe("Shopify catalog", () => {
  it("builds a bounded server-owned query and strips query-language injection", () => {
    const query = buildShopifySearchQuery({
      query: 'majlis OR status:draft NOT hidden -secret',
      productType: "floor sofa",
      color: "blue",
      dimensions: null,
      budgetMax: 2_000,
      currency: "USD",
      limit: 5,
    });

    expect(query).toMatch(/^status:active published_status:published /);
    expect(query).not.toContain(":draft");
    expect(query).toContain('"OR"');
    expect(query).toContain('"NOT"');
    expect(query).not.toMatch(/\sOR\s/);
    expect(query).not.toMatch(/\sNOT\s/);
    expect(query.length).toBeLessThanOrEqual(240);
  });

  it("returns unavailable instead of inventing products when not configured", async () => {
    const catalog = new ShopifyCatalog({ apiVersion: "2026-07" });
    const result = await catalog.searchProducts({
      query: "majlis",
      productType: null,
      color: null,
      dimensions: null,
      budgetMax: null,
      currency: null,
      limit: 5,
    });

    expect(result).toEqual({
      available: false,
      reason: "Live Shopify catalog is not configured.",
      products: [],
      factSourceIds: [],
    });
  });
});
