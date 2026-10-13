import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/protocol/normalize.js";

const chat = {
  model: "synthetic",
  messages: [{ role: "user", content: "prompt-secret" }],
};

describe("client request compatibility", () => {
  it("omits an empty stop string as an ineffective optional value", () => {
    const result = normalizeRequest({ ...chat, stop: "" }, "chat");
    expect(result.ignoredParams).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      path: "stop",
      action: "normalized",
      reason: "empty_optional",
    });
  });
  it("filters WorkBuddy/PFM Chat metadata with value-free paths and preserves message text", () => {
    const result = normalizeRequest(
      {
        model: "synthetic",
        messages: [
          {
            role: "user",
            content: "prompt-secret",
            name: "client-secret",
            startsNewUserRequest: true,
            vendor_extra: { token: "credential-secret" },
          },
          {
            role: "assistant",
            content: "output-secret",
            reasoning_content: "reasoning-secret",
            name: "assistant",
          },
          { role: "user", content: [{ type: "text", text: "second prompt" }] },
        ],
      },
      "chat",
    );
    expect(result.body.input.map((item: any) => item.content[0].text)).toEqual([
      "prompt-secret",
      "output-secret",
      "second prompt",
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "messages[0].name",
          action: "filtered",
          reason: "client_metadata",
        },
        {
          path: "messages[0].startsNewUserRequest",
          action: "filtered",
          reason: "client_metadata",
        },
        {
          path: "messages[0].vendor_extra",
          action: "filtered",
          reason: "client_metadata",
        },
        {
          path: "messages[1].reasoning_content",
          action: "filtered",
          reason: "client_metadata",
        },
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /prompt-secret|output-secret|reasoning-secret|credential-secret|client-secret/,
    );
    expect(result.responseContext).toEqual({
      toolNames: [],
      legacyFunctionCall: false,
    });
    expect(normalizeRequest(chat, "chat").responseContext).not.toBe(
      result.responseContext,
    );
  });

  it.each(["chat", "responses"] as const)(
    "treats known optional nulls and disabled defaults as absent on %s",
    (format) => {
      const result = normalizeRequest(
        {
          model: "synthetic",
          ...(format === "chat"
            ? { messages: [{ role: "user", content: "x" }] }
            : { input: "x" }),
          stream: null,
          store: null,
          tools: null,
          tool_choice: null,
          parallel_tool_calls: null,
          reasoning: null,
          text: null,
          stream_options: null,
          stop: null,
          n: format === "chat" ? 1 : null,
          background: false,
          logprobs: false,
          top_logprobs: 0,
          previous_response_id: null,
          conversation: null,
          include: null,
          prompt_cache_options: null,
          instructions: null,
          service_tier: null,
          future_model_option: { schema: { default: null } },
          future_scalar: null,
        },
        format,
      );
      expect(result.body).toEqual({
        model: "synthetic",
        store: false,
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "x" }],
          },
        ],
        future_model_option: { schema: { default: null } },
        future_scalar: null,
      });
      expect(result.stream).toBe(false);
      expect(result.ignoredParams).toEqual([]);
      expect(result.diagnostics).toContainEqual({
        path: "tools",
        action: "normalized",
        reason: "null_optional",
      });
    },
  );

  it.each(["chat", "responses"] as const)(
    "omits empty tools and stop on %s",
    (format) => {
      const result = normalizeRequest(
        {
          model: "m",
          ...(format === "chat" ? { messages: chat.messages } : { input: "x" }),
          tools: [],
          stop: [],
        },
        format,
      );
      expect(result.body.tools).toBeUndefined();
      expect(result.body.stop).toBeUndefined();
      expect(result.ignoredParams).toEqual([]);
      expect(result.diagnostics).toContainEqual({
        path: "stop",
        action: "normalized",
        reason: "empty_optional",
      });
    },
  );

  it.each(["chat", "responses"] as const)(
    "filters SIWC sampling knobs with diagnostics on %s",
    (format) => {
      const ignored = {
        stop: ["stop-secret"],
        seed: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        logit_bias: { "17": 1 },
        top_k: 20,
        min_p: 0.1,
        repeat_penalty: 1.1,
      };
      const result = normalizeRequest(
        {
          model: "m",
          ...(format === "chat" ? { messages: chat.messages } : { input: "x" }),
          ...ignored,
        },
        format,
      );
      expect(result.ignoredParams).toEqual(Object.keys(ignored));
      for (const key of Object.keys(ignored)) {
        expect(result.body).not.toHaveProperty(key);
        expect(result.diagnostics).toContainEqual({
          path: key,
          action: "filtered",
          reason: "siwc_ignored_parameter",
        });
      }
      expect(JSON.stringify(result.diagnostics)).not.toContain("stop-secret");
    },
  );

  it("normalizes only optional protocol nulls, never schema defaults, arguments or business JSON", () => {
    const schema = {
      type: "object",
      properties: { name: { type: ["string", "null"], default: null } },
      additionalProperties: false,
    };
    const source = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          refusal: null,
          annotations: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: '{"name":null,"tools":null}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"result":null}' },
        { role: "user", content: "next", tool_calls: null },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: schema,
            strict: null,
            description: null,
          },
        },
      ],
      reasoning: { effort: null, summary: null },
      text: { format: null, verbosity: null },
      response_format: null,
      reasoning_effort: null,
      verbosity: null,
      stream_options: { include_usage: null, include_obfuscation: null },
      future_option: { tools: null },
    };
    const original = structuredClone(source);
    const result = normalizeRequest(source, "chat");
    expect(result.body.tools[0].tools[0].parameters).toEqual(schema);
    expect(result.body.input[0].arguments).toBe('{"name":null,"tools":null}');
    expect(result.body.input[1].output).toBe('{"result":null}');
    expect(result.body.future_option).toEqual({ tools: null });
    expect(result.body.reasoning).toEqual({});
    expect(result.body.text).toEqual({});
    expect(result.body.stream_options).toEqual({});
    expect(source).toEqual(original);
  });

  it("preserves Responses native history except known client metadata", () => {
    const history = [
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        status: "completed",
        name: "client",
        startsNewUserRequest: true,
        reasoning_content: "client reasoning",
        native_extension: { nullable: null },
        content: [
          {
            type: "output_text",
            text: "prior",
            annotations: [],
            logprobs: null,
          },
        ],
      },
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "cipher-secret",
        summary: [],
        native_extension: null,
      },
      { type: "compaction", id: "comp_1", encrypted_content: "compact-secret" },
      {
        type: "function_call",
        call_id: "call_1",
        namespace: "workspace",
        name: "read",
        arguments: '{"path":null}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"result":null}',
      },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/image.png",
            detail: null,
          },
        ],
      },
    ];
    const source = {
      model: "m",
      input: history,
      tools: [
        {
          type: "namespace",
          name: "workspace",
          description: "Tools",
          tools: [
            { type: "function", name: "read", parameters: { default: null } },
          ],
        },
      ],
      include: ["reasoning.encrypted_content"],
    };
    const result = normalizeRequest(source, "responses");
    const expected = structuredClone(history);
    delete expected[0]!.name;
    delete expected[0]!.startsNewUserRequest;
    delete expected[0]!.reasoning_content;
    delete (expected[0]!.content as any[])[0].logprobs;
    delete (expected[5]!.content as any[])[0].detail;
    expect(result.body.input).toEqual(expected);
    expect(result.body.tools).toEqual(source.tools);
    expect(history[0]!.name).toBe("client");
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /cipher-secret|compact-secret|client reasoning/,
    );
  });

  it("accepts Chat reasoning and text aliases and matching combined fields", () => {
    const schema = {
      type: "object",
      properties: { nullable: { default: null } },
    };
    const result = normalizeRequest(
      {
        ...chat,
        reasoning: { effort: "high", summary: "auto" },
        reasoning_effort: "high",
        text: {
          format: { type: "json_schema", name: "answer", schema },
          verbosity: "low",
        },
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema },
        },
        verbosity: "low",
      },
      "chat",
    );
    expect(result.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(result.body.text).toEqual({
      format: { type: "json_schema", name: "answer", schema },
      verbosity: "low",
    });
    expect(
      normalizeRequest(
        {
          ...chat,
          reasoning: { effort: "future" },
          text: { format: { type: "text" } },
        },
        "chat",
      ).body.reasoning,
    ).toEqual({ effort: "future" });
  });

  it.each([
    [
      { reasoning: { effort: "high" }, reasoning_effort: "low" },
      "reasoning_effort",
    ],
    [
      {
        text: { format: { type: "text" } },
        response_format: { type: "json_object" },
      },
      "response_format",
    ],
    [{ text: { verbosity: "low" }, verbosity: "high" }, "verbosity"],
  ])(
    "rejects conflicting aliases at the concrete field %j",
    (options, param) => {
      expect(() =>
        normalizeRequest({ ...chat, ...options }, "chat"),
      ).toThrowError(
        expect.objectContaining({
          status: 400,
          code: "invalid_request",
          param,
        }),
      );
    },
  );

  it.each([
    [{ n: 2 }, "n"],
    [{ logprobs: true }, "logprobs"],
    [{ top_logprobs: 1 }, "top_logprobs"],
    [{ store: true }, "store"],
    [{ background: true }, "background"],
    [{ conversation: "conv_1" }, "conversation"],
    [{ previous_response_id: "resp_1" }, "previous_response_id"],
    [
      { messages: [{ role: "alien", content: "x", name: "ignore" }] },
      "messages[0].role",
    ],
    [
      {
        messages: [
          { role: "user", content: [{ type: "input_audio", data: "x" }] },
        ],
      },
      "messages[0].content[0]",
    ],
    [{ tools: [{ type: "file_search" }] }, "tools[0]"],
  ])("keeps semantic rejection for %j", (options, param) => {
    expect(() =>
      normalizeRequest({ ...chat, ...options }, "chat"),
    ).toThrowError(expect.objectContaining({ status: 400, param }));
  });

  it("retains filtered diagnostics when later validation rejects the request", () => {
    expect(() =>
      normalizeRequest(
        {
          model: "m",
          messages: [
            { role: "user", content: "secret", name: "ignored" },
            { role: "alien", content: "secret" },
          ],
        },
        "chat",
      ),
    ).toThrowError(
      expect.objectContaining({
        param: "messages[1].role",
        diagnostics: expect.arrayContaining([
          {
            path: "messages[0].name",
            action: "filtered",
            reason: "client_metadata",
          },
        ]),
      }),
    );
  });
});
