import type { JsonObject } from "../../src/auth/runtime.js";

// SOURCE-DERIVED / SYNTHETIC, never captured real client requests.
// Text, tool names/IDs, option values, URLs, file data and encrypted carriers are synthetic.
// WorkBuddy's original 5.7.6 failure proves only rejection of startsNewUserRequest.
// PFM structures come from BaseModelClient.java in the pinned SDK sources jar plus
// OpenAiRawDebugModelClient.java; Agent2API shapes model its outbound Rust code, not
// execution of that converter. Installed Agent2API 3.0.3 is not mapped to this commit.
export const contractSources = {
  workBuddy: {
    version: "WorkBuddy 5.7.6 (observed field only)",
    evidence: "original unsupported_parameter report: startsNewUserRequest",
  },
  pfm: {
    version:
      "PFM 564459636efac48df417191f7144413110afb90c / openJiuwen 0.1.13.post1",
    sdkJarSha256:
      "9312B13C0A7ABE4A1A7840D646C9136ADAEC7647D73B49BD6878A0C484322F7A",
    rawClientSha256:
      "C61A61949795A229288A052D6DEE618490DB3E031A4736FFE185516BC1E56FCA",
    evidence:
      "BaseModelClient.java:189-218,296-345; OpenAiRawDebugModelClient.java:350,681-692,1211-1260",
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

export function pfmRequest(history: JsonObject[] = []): JsonObject {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "读取 alpha 和 beta" }, ...history],
    tools: structuredClone(tools),
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
    // Values are synthetic configured values, not claims about PFM defaults.
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 512,
    user: "synthetic-user",
    seed: 7,
    stop: ["synthetic-stop"],
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
