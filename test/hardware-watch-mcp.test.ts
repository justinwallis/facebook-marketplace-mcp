import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runMcpSearches, WatchStageTimeout } from "../scripts/hardware-watch-mcp.js";

type Stage = "spawn" | "initialize" | "tools" | "search";

class MockMcpChild {
  terminated = false;
  transport = {
    pid: 4242,
    start: async () => {
      if (this.stage === "spawn") await new Promise<void>(() => undefined);
    },
    close: async () => { this.terminated = true; },
  };
  client = {
    connect: async (transport: { start?: () => Promise<void> }) => {
      await transport.start?.();
      if (this.stage === "initialize") await new Promise<void>(() => undefined);
    },
    listTools: async () => {
      if (this.stage === "tools") await new Promise<void>(() => undefined);
      return { tools: [{ name: "facebook_marketplace_search_listings" }] };
    },
    callTool: async () => {
      if (this.stage === "search") await new Promise<void>(() => undefined);
      return { structuredContent: { listings: [] } };
    },
    close: async () => { this.terminated = true; },
  };

  constructor(public readonly stage: Stage) {}
}

for (const stage of ["spawn", "initialize", "tools", "search"] as const) {
  test(`identifies and terminates a mocked MCP child hung at ${stage}`, async () => {
    const child = new MockMcpChild(stage);
    const progress: string[] = [];
    await assert.rejects(
      runMcpSearches({
        client: child.client,
        transport: child.transport,
        searches: [{ kind: "mac", query: "Mac Studio Max" }],
        callArguments: () => ({ name: "search" }),
        parseCount: () => 0,
        progress: (message) => progress.push(message),
        startupTimeoutMs: 20,
        requestTimeoutMs: 20,
        queueTimeoutMs: 20,
      }),
      (error: unknown) => error instanceof WatchStageTimeout && error.stage === (stage === "spawn" ? "MCP child spawn" : stage === "initialize" ? "MCP initialize" : stage === "tools" ? "tool discovery" : 'Marketplace search "Mac Studio Max" after rate-limit slot'),
    );
    assert.equal(child.terminated, true);
    assert.ok(progress.some((message) => message.includes("shutdown: complete")));
  });
}

test("does not spend the search timeout budget on a delayed rate-limit slot", async () => {
  const stderr = new EventEmitter();
  let terminated = false;
  const transport = {
    pid: 4343,
    stderr,
    async start() {},
    async close() { terminated = true; },
  };
  const client = {
    async connect(transportWithStart: { start?: () => Promise<void> }) { await transportWithStart.start?.(); },
    async listTools() { return { tools: [{ name: "search" }] }; },
    async callTool() {
      stderr.emit("data", "[facebook-mcp-timing] rate-limit queue wait start\n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stderr.emit("data", "[facebook-mcp-timing] rate-limit queue wait: 30ms\n[facebook-mcp-timing] network/search duration: 5ms\n");
      return { structuredContent: { listings: [] } };
    },
    async close() { terminated = true; },
  };
  const progress: string[] = [];
  const result = await runMcpSearches({
    client,
    transport,
    searches: [{ kind: "mac", query: "Mac Studio Max" }],
    callArguments: () => ({ name: "search" }),
    parseCount: () => 0,
    progress: (message) => progress.push(message),
    queueTimeoutMs: 50,
    requestTimeoutMs: 10,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(terminated, true);
  assert.ok(progress.some((message) => message.includes("rate-limit queue wait: 30ms")));
  assert.ok(progress.some((message) => message.includes("network/search duration: 5ms")));
  assert.ok(progress.some((message) => message.includes("tool-call duration:")));
});

test("times out and terminates a search that hangs after the rate-limit slot", async () => {
  const stderr = new EventEmitter();
  let terminated = false;
  const transport = {
    pid: 4344,
    stderr,
    async start() {},
    async close() { terminated = true; },
  };
  const client = {
    async connect(transportWithStart: { start?: () => Promise<void> }) { await transportWithStart.start?.(); },
    async listTools() { return { tools: [{ name: "search" }] }; },
    async callTool() {
      stderr.emit("data", "[facebook-mcp-timing] rate-limit queue wait: 1ms\n[facebook-mcp-timing] network/search duration: 1ms\n");
      await new Promise<void>(() => undefined);
    },
    async close() { terminated = true; },
  };
  await assert.rejects(
    runMcpSearches({
      client,
      transport,
      searches: [{ kind: "mac", query: "Mac Studio Max" }],
      callArguments: () => ({ name: "search" }),
      parseCount: () => 0,
      queueTimeoutMs: 20,
      requestTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof WatchStageTimeout && error.stage === 'Marketplace search "Mac Studio Max" after rate-limit slot',
  );
  assert.equal(terminated, true);
});
