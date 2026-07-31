import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runPassthrough(chunks, model = "fallback-model") {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks.join("\n\n") + "\n\n"));
      controller.close();
    },
  });
  return new Response(source.pipeThrough(
    createPassthroughStreamWithLogger("opencode", null, model),
  )).text();
}

function dataChunks(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

describe("OpenAI passthrough stream normalization", () => {
  it("reuses required fields on metadata-only chunks for strict clients", async () => {
    const id = "0d283cea-99e3-4e1f-92d1-a829f6a0c6e7";
    const output = await runPassthrough([
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash-free",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "test_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      })}`,
      `data: ${JSON.stringify({
        choices: [],
        "x-opencode-type": "inference-cost",
        cost: "0.00000000",
        normalizedUsage: { inputTokens: 10, outputTokens: 2 },
        object: "chat.completion.chunk",
        created: 2,
      })}`,
      "data: [DONE]",
    ]);

    const chunks = dataChunks(output);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      id,
      model: "deepseek-v4-flash-free",
      object: "chat.completion.chunk",
      created: 2,
      choices: [],
    });
  });

  it("generates required fields when first OpenAI chunk omits them", async () => {
    const output = await runPassthrough([
      `data: ${JSON.stringify({ choices: [], object: "chat.completion.chunk", created: 2 })}`,
      "data: [DONE]",
    ]);

    const [chunk] = dataChunks(output);
    expect(chunk.id).toMatch(/^chatcmpl-/);
    expect(chunk.model).toBe("fallback-model");
  });
});
