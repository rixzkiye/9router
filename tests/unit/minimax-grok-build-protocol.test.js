import { describe, expect, it } from "vitest";

import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveRequestTransport } from "../../open-sse/services/provider.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleBypassRequest } from "../../open-sse/utils/bypassHandler.js";

describe("MiniMax transport selection for Grok Build", () => {
  it("pairs MiniMax-M3's Claude body with the Anthropic transport", () => {
    const modelTarget = getModelTargetFormat("minimax", "MiniMax-M3");
    expect(modelTarget).toBe(FORMATS.CLAUDE);

    const { runtimeTransport, targetFormat } = resolveRequestTransport(
      "minimax",
      FORMATS.OPENAI,
      modelTarget,
    );

    expect(targetFormat).toBe(FORMATS.CLAUDE);
    expect(runtimeTransport).toMatchObject({
      format: FORMATS.CLAUDE,
      baseUrl: "https://api.minimax.io/anthropic/v1/messages",
    });
  });

  it("keeps MiniMax-M2.7 on the OpenAI transport for Chat Completions clients", () => {
    const { runtimeTransport, targetFormat } = resolveRequestTransport(
      "minimax",
      FORMATS.OPENAI,
      getModelTargetFormat("minimax", "MiniMax-M2.7"),
    );

    expect(targetFormat).toBe(FORMATS.OPENAI);
    expect(runtimeTransport?.format).toBe(FORMATS.OPENAI);
  });

  it("keeps Claude-native clients on the Anthropic transport", () => {
    const { runtimeTransport, targetFormat } = resolveRequestTransport(
      "minimax",
      FORMATS.CLAUDE,
      getModelTargetFormat("minimax", "MiniMax-M3"),
    );

    expect(targetFormat).toBe(FORMATS.CLAUDE);
    expect(runtimeTransport).toMatchObject({
      format: FORMATS.CLAUDE,
      baseUrl: "https://api.minimax.io/anthropic/v1/messages",
      urlSuffix: "?beta=true",
      auth: { header: "x-api-key", scheme: "raw" },
    });
  });

  it("uses the China Anthropic host for minimax-cn", () => {
    const { runtimeTransport, targetFormat } = resolveRequestTransport(
      "minimax-cn",
      FORMATS.CLAUDE,
      getModelTargetFormat("minimax-cn", "MiniMax-M3"),
    );

    expect(targetFormat).toBe(FORMATS.CLAUDE);
    expect(runtimeTransport).toMatchObject({
      baseUrl: "https://api.minimaxi.com/anthropic/v1/messages",
      auth: { header: "x-api-key", scheme: "raw" },
    });
  });
});

describe("MiniMax Anthropic multi-turn normalization", () => {
  it("does not inject OpenAI reasoning_content into the Anthropic transport", () => {
    const executor = new DefaultExecutor("minimax");
    const body = {
      model: "MiniMax-M3",
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect files" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_probe", name: "list_dir", input: {} }],
        },
      ],
    };

    const result = executor.transformRequest("MiniMax-M3", structuredClone(body), true, {
      runtimeTransport: { format: FORMATS.CLAUDE },
    });
    expect(result.messages[1].reasoning_content).toBeUndefined();
  });

  it("keeps reasoning_content injection on MiniMax's OpenAI transport", () => {
    const executor = new DefaultExecutor("minimax");
    const body = {
      model: "MiniMax-M2.7",
      messages: [
        { role: "user", content: "Inspect files" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_probe", type: "function", function: { name: "list_dir", arguments: "{}" } }] },
      ],
    };

    const result = executor.transformRequest("MiniMax-M2.7", structuredClone(body), true, {
      runtimeTransport: { format: FORMATS.OPENAI },
    });
    expect(result.messages[1].reasoning_content).toBe(" ");
  });
});

describe("Grok Build session-title bypass", () => {
  it("returns a local session_title tool call without provider routing", async () => {
    const result = handleBypassRequest({
      model: "grok-build",
      messages: [
        { role: "system", content: "Generate a short session title." },
        { role: "user", content: "<user_query>Fix MiniMax M3 tool calling</user_query>" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "session_title",
          parameters: {
            type: "object",
            required: ["session_title"],
            properties: { session_title: { type: "string" } },
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "session_title" } },
      stream: true,
    }, "grok-build", "grok-shell/0.2.103 (linux; x86_64)");

    expect(result?.success).toBe(true);
    const sse = await result.response.text();
    const events = sse
      .split("\n")
      .filter(line => line.startsWith("data: {") )
      .map(line => JSON.parse(line.slice(6)));
    const toolCall = events[0].choices[0].delta.tool_calls[0];

    expect(toolCall.function.name).toBe("session_title");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      session_title: "Fix MiniMax M3 tool calling",
    });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(sse).toContain("data: [DONE]");
  });

  it("returns Anthropic SSE when Grok Build uses the messages backend", async () => {
    const result = handleBypassRequest({
      model: "grok-build",
      messages: [{ role: "user", content: [{ type: "text", text: "Fix M3" }] }],
      tools: [{
        name: "session_title",
        input_schema: {
          type: "object",
          required: ["session_title"],
          properties: { session_title: { type: "string" } },
        },
      }],
      tool_choice: { type: "tool", name: "session_title" },
      stream: true,
    }, "grok-build", "grok-shell/0.2.103 (linux; x86_64)");

    expect(result?.success).toBe(true);
    const sse = await result.response.text();
    expect(sse).toContain("event: message_start");
    expect(sse).toContain('"type":"tool_use"');
    const dataLines = sse
      .split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const argsDelta = dataLines.find(event => event.type === "content_block_delta");
    expect(JSON.parse(argsDelta.delta.partial_json)).toEqual({ session_title: "Fix M3" });
    expect(sse).toContain('"stop_reason":"tool_use"');
    expect(sse).toContain("event: message_stop");
  });

  it("does not bypass ordinary Grok Build model requests", () => {
    const result = handleBypassRequest({
      messages: [{ role: "user", content: "Fix this bug" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      stream: true,
    }, "MiniMax-M3", "grok-shell/0.2.103 (linux; x86_64)");

    expect(result).toBeNull();
  });
});
