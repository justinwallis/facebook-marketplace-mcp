import test from "node:test";
import assert from "node:assert/strict";
import { candidateScore, classifyDistance, qualifiesAsLocalCandidate } from "../scripts/hardware-watch-filter.js";

const listing = (overrides: Record<string, unknown> = {}) => ({
  id: "test",
  title: "M2 Max Mac Studio 96GB 1TB",
  price: "$1,600",
  location: "Baltimore, MD",
  url: "https://www.facebook.com/marketplace/item/test/",
  is_pending: false,
  ...overrides,
});

test("excludes a clearly distant California listing from local candidates", () => {
  const result = classifyDistance(listing({ location: "Los Angeles, CA" }));
  assert.equal(result.status, "out_of_radius");
  assert.equal(qualifiesAsLocalCandidate(listing({ location: "Los Angeles, CA" }), "mac"), false);
});

test("accepts an in-radius listing with a documented Mac target", () => {
  const result = classifyDistance(listing());
  assert.equal(result.status, "in_radius");
  assert.ok(result.distanceKm !== null && result.distanceKm < 80);
  assert.equal(qualifiesAsLocalCandidate(listing(), "mac"), true);
});

test("normalizes the full state names used by saved Marketplace reports", () => {
  const inRadius = listing({
    id: "report-shaped-md",
    location: "Baltimore, Maryland",
    image_url: "https://image.example/report-shaped",
    seller_name: "Example seller",
  });
  const outOfRadius = listing({
    id: "report-shaped-ca",
    location: "Citrus Heights, California",
    image_url: "https://image.example/report-shaped-ca",
    seller_name: "Example seller",
  });
  assert.equal(classifyDistance(inRadius).status, "in_radius");
  assert.equal(classifyDistance(outOfRadius).status, "out_of_radius");
});

test("prefers returned coordinates over ambiguous location text", () => {
  const listingWithCoordinates = listing({
    location: "Baltimore, MD",
    latitude: 34.0522,
    longitude: -118.2437,
  });
  const result = classifyDistance(listingWithCoordinates);
  assert.equal(result.method, "coordinates");
  assert.equal(result.status, "out_of_radius");
  assert.equal(qualifiesAsLocalCandidate(listingWithCoordinates, "mac"), false);
});

test("keeps missing or unknown location unverified and out of the alert set", () => {
  const unknown = listing({ location: "Somewhere, ZZ" });
  assert.equal(classifyDistance(unknown).status, "unverified");
  assert.equal(qualifiesAsLocalCandidate(unknown, "mac"), false);
});

test("does not qualify a Florida result even when its hardware and price look attractive", () => {
  const florida = listing({ location: "Miami, FL", title: "M2 Max Mac Studio 96GB 1TB", price: "$1,500" });
  assert.equal(candidateScore(florida, "mac"), 10);
  assert.equal(classifyDistance(florida).status, "out_of_radius");
  assert.equal(qualifiesAsLocalCandidate(florida, "mac"), false);
});
