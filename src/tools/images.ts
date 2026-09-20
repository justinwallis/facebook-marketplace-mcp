import type { z } from "zod/v4";
import { getListingImagesInput } from "../mcp/contracts.js";
import type { MarketplaceService } from "../mcp/types.js";
import { toolErrorResponse } from "../utils/diagnostics.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function isFacebookCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "fbcdn.net" || url.hostname.endsWith(".fbcdn.net"))
    );
  } catch {
    return false;
  }
}

async function downloadListingImage(url: string) {
  if (!isFacebookCdnUrl(url)) {
    throw new Error("Photo URL is not an HTTPS Facebook CDN URL.");
  }

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Photo request failed with HTTP ${response.status}.`);
  }

  const mimeType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported photo type: ${mimeType ?? "missing"}.`);
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
    throw new Error("Photo exceeds the 10 MB safety limit.");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Photo exceeds the 10 MB safety limit.");
  }

  return {
    type: "image" as const,
    data: bytes.toString("base64"),
    mimeType,
  };
}

export function createGetListingImagesHandler(service: MarketplaceService) {
  return async (args: z.infer<typeof getListingImagesInput>) => {
    try {
      const listing = await service.getListingDetail(args.listing_id);
      const imageUrls = [...new Set(listing.images.filter(Boolean))];
      const requested = args.image_numbers
        ? [...new Set(args.image_numbers)].slice(0, 10)
        : Array.from(
            { length: Math.min(args.max_images, imageUrls.length) },
            (_, index) => index + 1,
          );

      const returnedImages: number[] = [];
      const failures: Array<{ image_number: number; message: string }> = [];
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text: `Photos for ${listing.title || `Marketplace listing ${args.listing_id}`}.`,
        },
      ];

      for (const imageNumber of requested) {
        const url = imageUrls[imageNumber - 1];
        if (!url) {
          failures.push({
            image_number: imageNumber,
            message: "Requested photo number is not available.",
          });
          continue;
        }

        try {
          content.push(await downloadListingImage(url));
          returnedImages.push(imageNumber);
        } catch (error) {
          failures.push({
            image_number: imageNumber,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (failures.length > 0) {
        content.push({
          type: "text",
          text: [
            "Some requested photos could not be returned:",
            ...failures.map(
              (failure) =>
                `- Photo ${failure.image_number}: ${failure.message}`,
            ),
          ].join("\n"),
        });
      }

      return {
        content,
        structuredContent: {
          listing_id: args.listing_id,
          title: listing.title,
          requested_images: requested,
          returned_images: returnedImages,
          failures,
        },
        ...(requested.length > 0 && returnedImages.length === 0
          ? { isError: true as const }
          : {}),
      };
    } catch (error) {
      return toolErrorResponse(
        "facebook_marketplace_get_listing_images",
        args,
        error,
        "Unable to fetch Marketplace listing photos",
      );
    }
  };
}
