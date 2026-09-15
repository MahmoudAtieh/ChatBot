import { z } from "zod";

export interface ProductSearchInput {
  query: string;
  productType: string | null;
  color: string | null;
  dimensions: string | null;
  budgetMax: number | null;
  currency: string | null;
  limit: number;
}

export interface ProductVariantResult {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number;
  inventoryPolicy: string;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ProductResult {
  factSourceId: string;
  id: string;
  title: string;
  handle: string;
  description: string;
  productType: string;
  tags: string[];
  url: string;
  totalInventory: number;
  priceRange: {
    min: { amount: string; currencyCode: string };
    max: { amount: string; currencyCode: string };
  };
  variants: ProductVariantResult[];
}

export interface ProductSearchResult {
  available: boolean;
  reason?: string;
  query?: string;
  products: ProductResult[];
  factSourceIds: string[];
}

const moneySchema = z.object({ amount: z.string(), currencyCode: z.string() });
const variantSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  availableForSale: z.boolean(),
  inventoryQuantity: z.number(),
  inventoryPolicy: z.string(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
});
const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  description: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  onlineStoreUrl: z.string().nullable(),
  totalInventory: z.number(),
  priceRangeV2: z.object({ minVariantPrice: moneySchema, maxVariantPrice: moneySchema }),
  variants: z.object({ nodes: z.array(variantSchema) }),
});
const shopifyResponseSchema = z.object({
  data: z.object({ products: z.object({ nodes: z.array(productSchema) }) }).optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
});

const productSearchDocument = `
  query SearchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query, sortKey: RELEVANCE) {
      nodes {
        id
        title
        handle
        description
        productType
        tags
        status
        onlineStoreUrl
        totalInventory
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 50) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            availableForSale
            inventoryQuantity
            inventoryPolicy
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

export interface ShopifyCatalogOptions {
  storeDomain?: string;
  accessToken?: string;
  apiVersion: string;
  storefrontDomain?: string;
  fetchImplementation?: typeof fetch;
}

export class ShopifyCatalog {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ShopifyCatalogOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (options.storeDomain && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(options.storeDomain)) {
      throw new Error("SHOPIFY_STORE_DOMAIN must be a plain *.myshopify.com hostname.");
    }
  }

  get configured(): boolean {
    return Boolean(this.options.storeDomain && this.options.accessToken);
  }

  async searchProducts(input: ProductSearchInput): Promise<ProductSearchResult> {
    if (!this.configured) {
      return {
        available: false,
        reason: "Live Shopify catalog is not configured.",
        products: [],
        factSourceIds: [],
      };
    }

    const query = buildShopifySearchQuery(input);
    const response = await this.fetchImplementation(
      `https://${this.options.storeDomain}/admin/api/${this.options.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.options.accessToken!,
        },
        body: JSON.stringify({
          query: productSearchDocument,
          variables: { query, first: Math.min(Math.max(input.limit, 1), 10) },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      return {
        available: false,
        reason: `Shopify catalog request failed with status ${response.status}.`,
        products: [],
        factSourceIds: [],
      };
    }

    const parsed = shopifyResponseSchema.parse(await response.json());
    if (parsed.errors?.length || !parsed.data) {
      return {
        available: false,
        reason: "Shopify did not return a usable catalog result.",
        products: [],
        factSourceIds: [],
      };
    }

    const requestedCurrency = input.currency?.toUpperCase() ?? null;
    const requestedColor = input.color?.toLocaleLowerCase("und") ?? null;
    const products = parsed.data.products.nodes.map((product) => {
      const variants = product.variants.nodes.filter((variant) => {
        const withinBudget =
          input.budgetMax === null || Number.parseFloat(variant.price) <= input.budgetMax;
        const correctCurrency =
          requestedCurrency === null ||
          product.priceRangeV2.minVariantPrice.currencyCode.toUpperCase() === requestedCurrency;
        const correctColor =
          requestedColor === null ||
          variant.selectedOptions.some(
            (option) =>
              option.name.toLocaleLowerCase("und").includes("color") &&
              option.value.toLocaleLowerCase("und").includes(requestedColor),
          );
        return withinBudget && correctCurrency && correctColor;
      });

      const factSourceId = `shopify:${product.id}`;
      return {
        factSourceId,
        id: product.id,
        title: product.title,
        handle: product.handle,
        description: product.description.slice(0, 800),
        productType: product.productType,
        tags: product.tags.slice(0, 20),
        url:
          product.onlineStoreUrl ??
          `https://${this.options.storefrontDomain ?? "arabicsofa.com"}/products/${product.handle}`,
        totalInventory: product.totalInventory,
        priceRange: {
          min: product.priceRangeV2.minVariantPrice,
          max: product.priceRangeV2.maxVariantPrice,
        },
        variants: variants
          .sort((left, right) => Number(right.availableForSale) - Number(left.availableForSale))
          .slice(0, 8),
      } satisfies ProductResult;
    });

    const matchedProducts = products
      .filter((product) => product.variants.length > 0)
      .sort(
        (left, right) =>
          Number(right.variants.some((variant) => variant.availableForSale)) -
          Number(left.variants.some((variant) => variant.availableForSale)),
      );
    return {
      available: true,
      query,
      products: matchedProducts,
      factSourceIds: matchedProducts.map((product) => product.factSourceId),
    };
  }
}

export function buildShopifySearchQuery(input: ProductSearchInput): string {
  const terms = [input.query, input.productType, input.color, input.dimensions]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => sanitizeSearchText(value).split(" "))
    .filter(Boolean)
    .slice(0, 12);
  const parts = ["status:active", "published_status:published"];
  for (const term of terms) {
    const quotedTerm = `"${term}"`;
    if ([...parts, quotedTerm].join(" ").length > 240) break;
    parts.push(quotedTerm);
  }
  return parts.join(" ");
}

function sanitizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}.\-_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
