import { detectFormat } from "../services/provider.js";
import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { SKIP_PATTERNS } from "../config/runtimeConfig.js";
import { formatSSE } from "./stream.js";

/**
 * Check for bypass patterns - return fake response without calling provider
 * Only works for Claude CLI requests
 */
export function handleBypassRequest(body, model, userAgent = "", ccFilterNaming = false) {
  if (!body.messages?.length) return null;

  const messages = body.messages;
  const getText = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter(c => c.type === "text").map(c => c.text).join(" ");
    }
    return "";
  };

  // Grok Build generates session titles through the selected custom base URL but
  // hardcodes model="grok-build". Handle that bookkeeping call locally so it
  // cannot be misrouted to 9Router's Grok subscription provider.
  const selectedTool = body.tool_choice?.function?.name || body.tool_choice?.name;
  const titleTool = body.tools?.find(tool => (tool.function?.name || tool.name) === "session_title");
  if (model === "grok-build" && userAgent.includes("grok-shell") && titleTool && selectedTool === "session_title") {
    const userText = messages
      .filter(message => message.role === "user")
      .map(message => getText(message.content))
      .join(" ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const title = userText.split(" ").filter(Boolean).slice(0, 8).join(" ") || "New coding session";
    const args = { session_title: title };
    return titleTool.function
      ? createOpenAIToolResponse(model, "session_title", args, body.stream !== false)
      : createClaudeToolResponse(model, "session_title", args, body.stream !== false);
  }

  if (!userAgent.includes("claude-cli")) return null;

  let shouldBypass = false;
  let namingBypass = false;

  // Pattern 1: Title extraction (assistant message = "{")
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "assistant" && lastMsg.content?.[0]?.text === "{") {
    shouldBypass = true;
  }

  // Pattern 2: Warmup
  if (!shouldBypass) {
    const firstText = getText(messages[0]?.content);
    if (firstText === "Warmup") {
      shouldBypass = true;
    }
  }

  // Pattern 3: Count
  if (!shouldBypass && messages.length === 1 && messages[0]?.role === "user") {
    const firstText = getText(messages[0]?.content);
    if (firstText === "count") {
      shouldBypass = true;
    }
  }

  // Pattern 4: Skip patterns
  if (!shouldBypass && SKIP_PATTERNS?.length) {
    const userMessages = messages.filter(m => m.role === "user");
    const userText = userMessages.map(m => getText(m.content)).join(" ");
    if (SKIP_PATTERNS.some(p => userText.includes(p))) {
      shouldBypass = true;
    }
  }

  // Pattern 5: CC naming request (topic title extraction by Claude Code CLI)
  // Claude format: system is top-level body.system field, not inside messages
  if (!shouldBypass && ccFilterNaming) {
    const systemMsg = messages.find(m => m.role === "system");
    const systemFromMessages = getText(systemMsg?.content);
    const systemFromBody = Array.isArray(body.system)
      ? body.system.filter(s => s.type === "text").map(s => s.text).join(" ")
      : (typeof body.system === "string" ? body.system : "");
    const systemText = systemFromMessages || systemFromBody;
    if (systemText.includes("isNewTopic")) {
      shouldBypass = true;
      namingBypass = true;
    }
  }

  if (!shouldBypass) return null;

  const sourceFormat = detectFormat(body);
  const stream = body.stream !== false;

  // For naming bypass, generate title from user message
  if (namingBypass) {
    const userMsg = messages.find(m => m.role === "user");
    const userText = getText(userMsg?.content);
    const title = userText.trim().split(/\s+/).slice(0, 3).join(" ");
    const namingText = JSON.stringify({ isNewTopic: true, title });
    return stream
      ? createStreamingResponse(sourceFormat, model, namingText)
      : createNonStreamingResponse(sourceFormat, model, namingText);
  }

  return stream 
    ? createStreamingResponse(sourceFormat, model)
    : createNonStreamingResponse(sourceFormat, model);
}

const DEFAULT_BYPASS_TEXT = "CLI Command Execution: Clear Terminal";

function createClaudeToolResponse(model, name, args, stream) {
  const id = `msg_${Date.now()}`;
  const toolUse = { type: "tool_use", id: `call_${Date.now()}`, name, input: args };
  const usage = { input_tokens: 1, output_tokens: 1 };

  if (!stream) {
    return {
      success: true,
      response: new Response(JSON.stringify({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [toolUse],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage,
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }),
    };
  }

  const events = [
    ["message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ["content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { ...toolUse, input: {} },
    }],
    ["content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }],
    ["message_stop", { type: "message_stop" }],
  ];
  const sse = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return {
    success: true,
    response: new Response(sse, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

function createOpenAIToolResponse(model, name, args, stream) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall = {
    index: 0,
    id: `call_${Date.now()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

  if (!stream) {
    return {
      success: true,
      response: new Response(JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        }],
        usage,
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }),
    };
  }

  const chunks = [
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }],
    },
    {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage,
    },
  ];
  return {
    success: true,
    response: new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

/**
 * Create OpenAI standard format response
 */
function createOpenAIResponse(model, text = DEFAULT_BYPASS_TEXT) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  };
}

/**
 * Create non-streaming response with translation
 * Use translator to convert OpenAI → sourceFormat
 */
function createNonStreamingResponse(sourceFormat, model, text) {
  const openaiResponse = createOpenAIResponse(model, text);

  // If sourceFormat is OpenAI, return directly
  if (sourceFormat === FORMATS.OPENAI) {
    return {
      success: true,
      response: new Response(JSON.stringify(openaiResponse), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      })
    };
  }

  // Use translator to convert: simulate streaming then collect all chunks
  const state = initState(sourceFormat);
  state.model = model;

  const openaiChunks = createOpenAIStreamingChunks(openaiResponse);
  const allTranslated = [];

  for (const chunk of openaiChunks) {
    const translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state);
    if (translated?.length > 0) {
      allTranslated.push(...translated);
    }
  }

  // Flush remaining
  const flushed = translateResponse(FORMATS.OPENAI, sourceFormat, null, state);
  if (flushed?.length > 0) {
    allTranslated.push(...flushed);
  }

  // For non-streaming, merge all chunks into final response
  const finalResponse = mergeChunksToResponse(allTranslated, sourceFormat);

  return {
    success: true,
    response: new Response(JSON.stringify(finalResponse), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    })
  };
}

/**
 * Create streaming response with translation
 * Use translator to convert OpenAI chunks → sourceFormat
 */
function createStreamingResponse(sourceFormat, model, text) {
  const openaiResponse = createOpenAIResponse(model, text);
  const state = initState(sourceFormat);
  state.model = model;

  // Create OpenAI streaming chunks
  const openaiChunks = createOpenAIStreamingChunks(openaiResponse);

  // Translate each chunk to sourceFormat using translator
  const translatedChunks = [];

  for (const chunk of openaiChunks) {
    const translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state);
    if (translated?.length > 0) {
      for (const item of translated) {
        translatedChunks.push(formatSSE(item, sourceFormat));
      }
    }
  }

  // Flush remaining events
  const flushed = translateResponse(FORMATS.OPENAI, sourceFormat, null, state);
  if (flushed?.length > 0) {
    for (const item of flushed) {
      translatedChunks.push(formatSSE(item, sourceFormat));
    }
  }

  // Add [DONE]
  translatedChunks.push("data: [DONE]\n\n");

  return {
    success: true,
    response: new Response(translatedChunks.join(""), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    })
  };
}

/**
 * Merge translated chunks into final response object (for non-streaming)
 * Takes the last complete chunk as the final response
 */
function mergeChunksToResponse(chunks, sourceFormat) {
  if (!chunks || chunks.length === 0) {
    return createOpenAIResponse("unknown");
  }

  // For most formats, the last chunk before done contains the complete response
  // Find the most complete chunk (usually the last one with content)
  let finalChunk = chunks[chunks.length - 1];

  // For Claude format, find the message_stop or final message
  if (sourceFormat === FORMATS.CLAUDE) {
    const messageStop = chunks.find(c => c.type === "message_stop");
    if (messageStop) {
      // Reconstruct complete message from chunks
      const contentDelta = chunks.find(c => c.type === "content_block_delta");
      const messageDelta = chunks.find(c => c.type === "message_delta");
      const messageStart = chunks.find(c => c.type === "message_start");

      if (messageStart?.message) {
        finalChunk = messageStart.message;
        // message_start.usage has input + cache; message_delta.usage has the
        // final output_tokens. Merge so cache survives (delta omits it).
        const startUsage = messageStart.message.usage;
        const deltaUsage = messageDelta?.usage;
        if (startUsage || deltaUsage) {
          finalChunk.usage = {
            ...(startUsage || {}),
            ...(deltaUsage || {}),
            ...(startUsage?.cache_read_input_tokens !== undefined
              ? { cache_read_input_tokens: startUsage.cache_read_input_tokens }
              : {}),
            ...(startUsage?.cache_creation_input_tokens !== undefined
              ? { cache_creation_input_tokens: startUsage.cache_creation_input_tokens }
              : {}),
            ...(startUsage?.input_tokens !== undefined
              ? { input_tokens: startUsage.input_tokens }
              : {})
          };
        }
      }
    }
  }

  return finalChunk;
}

/**
 * Create OpenAI streaming chunks from complete response
 */
function createOpenAIStreamingChunks(completeResponse) {
  const { id, created, model, choices } = completeResponse;
  const content = choices[0].message.content;

  return [
    // Chunk with content
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content
        },
        finish_reason: null
      }]
    },
    // Final chunk with finish_reason
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop"
      }],
      usage: completeResponse.usage
    }
  ];
}
