import type { JsonObject } from "../../src/auth/runtime.js";

// SOURCE-DERIVED / SYNTHETIC, never captured real client requests.
// Text, tool names/IDs, option values, URLs, file data and encrypted carriers are synthetic.
// WorkBuddy's original 5.7.6 failure proves only rejection of startsNewUserRequest.
// Agent2API shapes model its outbound Rust code, not execution of that converter. Installed Agent2API 3.0.3 is not mapped to this commit.
export const contractSources = {
  workBuddy: {
    version: "WorkBuddy 5.7.6 (observed field only)",
    evidence: "original unsupported_parameter report: startsNewUserRequest",
  },
  agent2api: {
    version: "Agent2API source e8a9d577983b3e9dcc5290b89cae20b204fcf222",
    evidence: "forward.rs:190-227,477-512; responses_outbound.rs:54-260",
  },
  standardSdk: {
    version: "openai-node 7.32.0",
    evidence: "package-lock.json; tests/integration.test.ts",
  },
} as const;

export const nullableSchema = {
  type: "object",
  properties: {
    result: {
      type: ["object", "null"],
      default: null,
      properties: { value: { type: ["string", "null"], default: null } },
    },
  },
  additionalProperties: false,
};

const tools = ["read_alpha", "read_beta"].map((name) => ({
  type: "function",
  function: {
    name,
    description: "Synthetic read-only fixture",
    parameters: {
      type: "object",
      properties: { path: { type: ["string", "null"], default: null } },
    },
  },
}));

export function workBuddyRequest(): JsonObject {
  return {
    model: "test-model",
    messages: [
      {
        role: "user",
        content: "synthetic WorkBuddy text",
        startsNewUserRequest: true,
      },
    ],
  };
}

export function agent2apiChatRequest(): JsonObject {
  // Post-forwarding body: alias already rewritten, no cross-protocol tools or _wb_* fields.
  return {
    model: "test-model",
    stream: true,
    messages: [
      { role: "system", content: "Synthetic system" },
      { role: "user", content: "Synthetic first turn" },
      {
        role: "assistant",
        content: "Synthetic prior text",
        tool_calls: [
          {
            id: "call_agent_chat",
            type: "function",
            function: { name: "read_alpha", arguments: '{"path":null}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_agent_chat",
        content: '{"value":null}',
      },
      { role: "user", content: "Synthetic second turn" },
    ],
    tools: [structuredClone(tools[0])],
    tool_choice: "auto",
    reasoning_effort: "low",
  };
}

export function agent2apiResponsesRequest(): JsonObject {
  // Source converter order: reasoning, non-empty assistant text, function calls.
  // This is the wire body AFTER internal encrypted carrier restoration and stream override.
  return {
    model: "test-model",
    stream: true,
    store: false,
    instructions: "Synthetic system\n\nSynthetic developer",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Synthetic first turn" }],
      },
      {
        type: "reasoning",
        id: "rs_agent",
        summary: [{ type: "summary_text", text: "Synthetic summary" }],
        encrypted_content: "synthetic-encrypted-agent",
      },
      {
        type: "message",
        id: "msg_agent",
        role: "assistant",
        content: [{ type: "output_text", text: "Synthetic prior text" }],
      },
      {
        type: "function_call",
        id: "fc_agent",
        call_id: "call_agent",
        name: "read_alpha",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_agent",
        output: '{"value":null}',
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Synthetic second turn" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_alpha",
        description: "Synthetic read-only fixture",
        parameters: tools[0]!.function.parameters,
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "low", summary: "auto" },
    temperature: 0.5,
    top_p: 0.9,
    max_output_tokens: 512,
    user: "synthetic-user",
    metadata: { synthetic: true },
    service_tier: "auto",
    parallel_tool_calls: true,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: structuredClone(nullableSchema),
        strict: true,
      },
    },
  };
}

export function mediaStructuredRequest(): JsonObject {
  return {
    model: "test-model",
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Synthetic media prompt" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,c3ludGhldGlj",
              detail: "low",
            },
          },
          {
            type: "file",
            file: {
              filename: "synthetic.txt",
              file_data: "data:text/plain;base64,c3ludGhldGlj",
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: structuredClone(nullableSchema),
      },
    },
  };
}
