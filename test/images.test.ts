import assert from "node:assert/strict";
import test from "node:test";
import { createGetListingImagesHandler } from "../src/tools/images.js";
import type { MarketplaceService } from "../src/mcp/types.js";

function serviceWithImages(images: string[]): MarketplaceService {
  return {
    async searchListings() {
      throw new Error("not used");
    },
    async searchLocation() {
      throw new Error("not used");
    },
    async getListingDetail(listingId: string) {
      return {
        id: listingId,
        title: "Test listing",
        description: "",
        price: "$10",
        location: "Testville",
        imageUrl: images[0] ?? "",
        images,
        sellerName: "Seller",
        postedDate: "",
        url: `https://www.facebook.com/marketplace/item/${listingId}/`,
        isPending: false,
        condition: "",
        seller: { name: "Seller", profileUrl: "" },
      };
    },
  };
}

test("returns bounded native image content from Facebook CDN URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": "4",
      },
    });

  try {
    const handler = createGetListingImagesHandler(
      serviceWithImages([
        "https://scontent.example.fbcdn.net/photo-1.jpg",
        "https://scontent.example.fbcdn.net/photo-2.jpg",
      ]),
    );
    const result = await handler({
      listing_id: "123",
      image_numbers: [2, 1, 2],
      max_images: 4,
    });

    assert.equal(result.isError, undefined);
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    assert.deepEqual(structured, {
      listing_id: "123",
      title: "Test listing",
      requested_images: [2, 1],
      returned_images: [2, 1],
      failures: [],
    });
    assert.equal(
      result.content.filter((item) => item.type === "image").length,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-Facebook image hosts without fetching them", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("should not fetch");
  };

  try {
    const handler = createGetListingImagesHandler(
      serviceWithImages(["https://example.com/photo.jpg"]),
    );
    const result = await handler({
      listing_id: "123",
      image_numbers: [1],
      max_images: 4,
    });

    assert.equal(result.isError, true);
    assert.equal(fetches, 0);
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    assert.deepEqual(structured?.returned_images, []);
    assert.match(
      JSON.stringify(structured?.failures),
      /Facebook CDN/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
