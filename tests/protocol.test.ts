import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/protocol/normalize.js";
import { collectResponse, renderStream } from "../src/protocol/events.js";
import type { JsonObject } from "../src/auth/runtime.js";

export async function* events(...values: JsonObject[]) {
  yield* values;
}
export const usage = {
  input_tokens: 11,
  output_tokens: 5,
  total_tokens: 16,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 3 },
};
export const finalResponse = (output: JsonObject[] = []) => ({
  id: "resp_test",
  object: "response",
  created_at: 17,
  model: "upstream-model",
  status: "completed",
  output,
  usage,
});
const completed = (output: JsonObject[] = []) => ({
  type: "response.completed",
  response: finalResponse(output),
});
export async function frames(source: AsyncIterable<string>) {
  const result: string[] = [];
  for await (const value of source) result.push(value);
  return result;
}
function chunks(values: string[]) {
  return values
    .filter((v) => !v.includes("[DONE]"))
    .map((v) => JSON.parse(v.split("data: ")[1]!.trim()));
}

describe("request normalization", () => {
  it.each(["responses", "chat"] as const)(
    "leaves unknown model options to upstream on %s safely",
    (format) => {
      const source = JSON.parse(
        '{"model":"synthetic","future_scalar":17,"future_model_option":{"level":2},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"temperature":0.5,"stream":false}',
      );
      Object.assign(
        source,
        format === "chat"
          ? {
              messages: [{ role: "user", content: "x" }],
              reasoning_effort: "future-effort",
            }
          : { input: "x", reasoning: { effort: "future-effort" } },
      );
      const result = normalizeRequest(source, format);
      expect(result.body).toMatchObject({
        future_scalar: 17,
        future_model_option: { level: 2 },
        reasoning: { effort: "future-effort" },
        stream: true,
        store: false,
      });
      expect(Object.getPrototypeOf(result.body)).toBe(Object.prototype);
      expect(Object.hasOwn(result.body, "__proto__")).toBe(true);
      expect(result.body.__proto__).toEqual({ polluted: true });
      expect(result.body.polluted).toBeUndefined();
      expect(result.ignoredParams).toEqual(["temperature"]);
      expect(result.stream).toBe(false);
      for (const [param, value] of Object.entries({
        previous_response_id: "prior",
        store: true,
        audio: { voice: "x" },
      }))
        expect(() =>
          normalizeRequest({ ...source, [param]: value }, format),
        ).toThrowError(
          expect.objectContaining({ code: "unsupported_parameter", param }),
        );
      expect(() =>
        normalizeRequest(
          { ...source, tools: [{ type: "image_generation" }] },
          format,
        ),
      ).toThrowError(expect.objectContaining({ code: "unsupported_tool" }));
    },
  );
  it.each(["messages", "reasoning_effort", "response_format", "verbosity"])(
    "rejects known Chat-only %s on Responses",
    (param) => {
      expect(() =>
        normalizeRequest(
          { model: "m", input: "x", [param]: "future" },
          "responses",
        ),
      ).toThrowError(
        expect.objectContaining({ code: "unsupported_parameter", param }),
      );
    },
  );
  it("merges Chat verbosity with structured response format", () => {
    const result = normalizeRequest(
      {
        model: "test",
        messages: [{ role: "user", content: "answer" }],
        verbosity: "low",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            schema: { type: "object" },
            strict: true,
          },
        },
      },
      "chat",
    );
    expect(result.body.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    });
    expect(result.body.verbosity).toBeUndefined();
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          verbosity: "invented",
        },
        "chat",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it.each([undefined, false, true])(
    "keeps include_usage=%s as downstream metadata",
    (includeUsage) => {
      const result = normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          stream: true,
          ...(includeUsage === undefined
            ? {}
            : {
                stream_options: {
                  include_usage: includeUsage,
                  include_obfuscation: false,
                },
              }),
        },
        "chat",
      );
      expect(result.renderOptions).toEqual({
        includeUsage: includeUsage === true,
        responseContext: result.responseContext,
      });
      expect(result.body.renderOptions).toBeUndefined();
      expect(result.body.stream_options?.include_usage).toBeUndefined();
      if (includeUsage !== undefined)
        expect(result.body.stream_options).toEqual({
          include_obfuscation: false,
        });
    },
  );
  it("routes flat named unpaired function outputs with the namespace of their definition", () => {
    const result = normalizeRequest(
      {
        model: "test",
        input: [
          { type: "function_call_output", name: "f", output: "notice" },
          {
            type: "function_call_output",
            name: "f",
            namespace: "native",
            output: "native notice",
          },
        ],
        tools: [{ type: "function", name: "f", parameters: {} }],
      },
      "responses",
    ).body;
    expect(result.input[0]).toEqual({
      type: "function_call_output",
      name: "f",
      namespace: result.tools[0].name,
      output: "notice",
    });
    expect(result.input[1]).toEqual({
      type: "function_call_output",
      name: "f",
      namespace: "native",
      output: "native notice",
    });
  });
  it("builds SDK-valid output-message history preserving refusal, citations and duplicate text identity", async () => {
    const citation = {
      type: "url_citation",
      start_index: 0,
      end_index: 6,
      title: "source",
      url: "https://example.com",
    };
    const prior = {
      type: "message",
      id: "upstream_message",
      status: "completed",
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "output_text", text: "answer", annotations: [citation] },
        { type: "refusal", refusal: "cannot" },
      ],
    };
    const chat = await collectResponse(
      events(completed([prior])),
      "chat",
      "test",
    );
    const messages = [
      { role: "user", content: "first" },
      chat.choices[0].message,
      chat.choices[0].message,
      { role: "user", content: "continue" },
    ];
    const normalized = normalizeRequest({ model: "test", messages }, "chat")
      .body.input;
    expect(normalized[1]).toMatchObject({
      type: "message",
      id: expect.any(String),
      status: "completed",
      role: "assistant",
      content: prior.content,
    });
    expect(normalized[1].id).not.toBe(normalized[2].id);
    expect(
      normalizeRequest({ model: "test", messages }, "chat").body.input[1].id,
    ).toBe(normalized[1].id);
    expect(
      normalizeRequest(
        { model: "test", input: [...normalized, prior] },
        "responses",
      ).body.input,
    ).toEqual([...normalized, prior]);
  });
  it("maps the SDK Chat nested custom grammar and accepts documented max reasoning effort", () => {
    const r = normalizeRequest(
      {
        model: "test",
        messages: [{ role: "user", content: "x" }],
        reasoning_effort: "max",
        tools: [
          {
            type: "custom",
            custom: {
              name: "patch",
              format: {
                type: "grammar",
                grammar: { syntax: "regex", definition: "[a-z]+" },
              },
            },
          },
        ],
      },
      "chat",
    ).body;
    expect(r.reasoning).toEqual({ effort: "max" });
    expect(r.tools[0].tools[0].format).toEqual({
      type: "grammar",
      syntax: "regex",
      definition: "[a-z]+",
    });
  });
  it("maps the standard Chat allowed_tools choice and passes advanced native fields", () => {
    expect(
      normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          tool_choice: {
            type: "allowed_tools",
            allowed_tools: {
              mode: "required",
              tools: [{ type: "function", function: { name: "f" } }],
            },
          },
        },
        "chat",
      ).body.tool_choice,
    ).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "f" }],
    });
    const advanced = {
      access_programs: { cyber: "standard" },
      context_management: [{ type: "compaction", compact_threshold: 2000 }],
    };
    expect(
      normalizeRequest({ model: "test", input: "x", ...advanced }, "responses")
        .body,
    ).toMatchObject(advanced);
  });
  it("accepts a flat native call returned from a previous independent request", () => {
    const first = normalizeRequest(
      {
        model: "test",
        input: "x",
        tools: [{ type: "function", name: "f", parameters: {} }],
      },
      "responses",
    ).body;
    const item = {
      type: "function_call",
      id: "i",
      name: "f",
      namespace: first.tools[0].name,
      call_id: "c",
      arguments: "{}",
    };
    expect(
      normalizeRequest(
        {
          model: "test",
          input: [
            item,
            { type: "function_call_output", call_id: "c", output: "ok" },
          ],
        },
        "responses",
      ).body.input[0],
    ).toEqual(item);
  });
  it("preserves native empty namespace descriptions and named unpaired outputs", () => {
    const tool = {
      type: "namespace",
      name: "native",
      description: "",
      tools: [{ type: "function", name: "f", parameters: {} }],
    };
    const input = {
      type: "function_call_output",
      name: "f",
      namespace: "native",
      output: "notification",
    };
    expect(
      normalizeRequest(
        { model: "test", input: [input], tools: [tool] },
        "responses",
      ).body,
    ).toMatchObject({ input: [input], tools: [tool] });
  });
  it("rejects reserved namespace collisions rather than stripping native identity", () => {
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          input: "x",
          tools: [
            {
              type: "namespace",
              name: "_mpf_v1_collision",
              description: "x",
              tools: [],
            },
          ],
        },
        "responses",
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported_parameter" }));
  });
  it.each([
    { reasoning: { effort: 42 } },
    { text: { format: { type: "json_schema", name: "missing_schema" } } },
    { text: { format: { type: "audio" } } },
    { include: ["message.output_text.logprobs"] },
    {
      tools: [
        {
          type: "custom",
          name: "f",
          format: { type: "grammar", syntax: "unknown", definition: "x" },
        },
      ],
    },
    {
      tools: [{ type: "function", name: "f", allowed_callers: "programmatic" }],
    },
  ])("rejects malformed nested semantics %j", (extra) => {
    expect(() =>
      normalizeRequest({ model: "test", input: "x", ...extra }, "responses"),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it("converts system/messages and explicitly reports ignored token/sampling settings", () => {
    const result = normalizeRequest(
      {
        model: "test",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "hi" },
        ],
        temperature: 0.5,
        max_tokens: 20,
      },
      "chat",
    );
    expect(result.stream).toBe(false);
    expect(result.body).toMatchObject({
      model: "test",
      store: false,
      stream: true,
      input: [
        { role: "developer", content: [{ type: "input_text", text: "rules" }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    expect(result.ignoredParams).toEqual(["temperature", "max_tokens"]);
  });
  it("normalizes native string input without mutating the caller", () => {
    const input = { model: "test", input: "你好", stream: true };
    expect(normalizeRequest(input, "responses").body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "你好" }],
      },
    ]);
    expect(input.input).toBe("你好");
  });
  it("maps Chat text/image/file, assistant refusal and tool result forms", () => {
    const r = normalizeRequest(
      {
        model: "test",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,eA==", detail: "low" },
              },
              {
                type: "file",
                file: {
                  file_data: "data:application/pdf;base64,eA==",
                  filename: "x.pdf",
                },
              },
            ],
          },
          { role: "assistant", content: null, refusal: "no" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_f",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
              {
                id: "call_c",
                type: "custom",
                custom: { name: "c", input: "hello" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_f", content: "ok" },
          { role: "tool", tool_call_id: "call_c", content: "custom ok" },
        ],
      },
      "chat",
    ).body;
    expect(r.input[0].content).toEqual([
      { type: "input_text", text: "read" },
      {
        type: "input_image",
        image_url: "data:image/png;base64,eA==",
        detail: "low",
      },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,eA==",
        filename: "x.pdf",
      },
    ]);
    expect(r.input[1].content).toEqual([{ type: "refusal", refusal: "no" }]);
    expect(r.input.slice(2)).toMatchObject([
      {
        type: "function_call",
        call_id: "call_f",
        name: "f",
        arguments: "{}",
        namespace: expect.any(String),
      },
      {
        type: "custom_tool_call",
        call_id: "call_c",
        name: "c",
        input: "hello",
        namespace: expect.any(String),
      },
      { type: "function_call_output", call_id: "call_f", output: "ok" },
      {
        type: "custom_tool_call_output",
        call_id: "call_c",
        output: "custom ok",
      },
    ]);
  });
  it("roundtrips flat function/custom names statelessly including choices and arguments", async () => {
    const a = normalizeRequest(
      {
        model: "test",
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: { type: "object" },
              strict: true,
            },
          },
          { type: "custom", custom: { name: "c", format: { type: "text" } } },
        ],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      "chat",
    ).body;
    expect(a.tools).toHaveLength(2);
    expect(a.tools[0]).toMatchObject({
      type: "namespace",
      name: expect.any(String),
      tools: [{ type: "function", name: "f", strict: true }],
    });
    expect(a.tool_choice).toEqual({ type: "function", name: "f" });
    const tool = {
      type: "function_call",
      id: "item",
      call_id: "call",
      name: "f",
      namespace: a.tools[0].name,
      arguments: '{"x":1}',
    };
    const r = await collectResponse(events(completed([tool])), "chat", "test");
    expect(r.choices[0].message.tool_calls).toEqual([
      {
        id: "call",
        type: "function",
        function: { name: "f", arguments: '{"x":1}' },
      },
    ]);
    const again = normalizeRequest(
      {
        model: "test",
        messages: [
          r.choices[0].message,
          { role: "tool", tool_call_id: "call", content: "done" },
        ],
      },
      "chat",
    );
    expect(again.body.input[0]).toMatchObject({
      call_id: "call",
      name: "f",
      namespace: tool.namespace,
    });
  });
  it("retains native namespaces/additional tools, reasoning encryption, annotations and web search", () => {
    const native = {
      model: "test",
      instructions: "rules",
      input: [
        { type: "message", role: "system", content: "rules" },
        {
          type: "reasoning",
          id: "r",
          encrypted_content: "cipher",
          summary: [],
        },
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "native",
              description: "native",
              tools: [
                { type: "custom", name: "patch", format: { type: "text" } },
              ],
            },
          ],
        },
      ],
      tools: [
        { type: "web_search", search_context_size: "low" },
        {
          type: "namespace",
          name: "n",
          description: "n",
          tools: [{ type: "function", name: "f", parameters: {} }],
        },
      ],
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object" },
          strict: true,
        },
      },
      include: ["reasoning.encrypted_content"],
    };
    const r = normalizeRequest(native, "responses").body;
    expect(r).toMatchObject({
      ...native,
      input: [
        { type: "message", role: "developer", content: "rules" },
        ...native.input.slice(1),
      ],
      store: false,
      stream: true,
    });
    expect(native.input[0]!.role).toBe("system");
  });
  it("converts structured output and reasoning effort", () => {
    const r = normalizeRequest(
      {
        model: "test",
        messages: [{ role: "user", content: "x" }],
        reasoning_effort: "high",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            schema: { type: "object" },
            strict: true,
          },
        },
      },
      "chat",
    ).body;
    expect(r.reasoning).toEqual({ effort: "high" });
    expect(r.text).toEqual({
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    });
  });
  it.each([
    { model: "", input: "x" },
    { model: "x", input: {} },
    { model: "x", input: [] },
    { model: "x", input: "x", stream: "true" },
  ])("rejects invalid request %j", (value) => {
    expect(() => normalizeRequest(value, "responses")).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
  it.each([
    "previous_response_id",
    "conversation",
    "background",
    "prompt",
    "moderation",
    "multi_agent",
    "max_tool_calls",
    "prompt_cache_retention",
    "truncation",
  ])("rejects unsupported feature %s", (key) => {
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          input: "x",
          [key]: key === "background" ? true : "value",
        },
        "responses",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsupported_parameter", param: key }),
    );
  });
  it.each([
    { n: 2 },
    { logprobs: true },
    { top_logprobs: 2 },
    { audio: { voice: "alloy" } },
    { modalities: ["audio"] },
    { web_search_options: {} },
  ])("rejects unsupported Chat semantics %j", (value) => {
    expect(() =>
      normalizeRequest(
        { model: "test", messages: [{ role: "user", content: "x" }], ...value },
        "chat",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it.each([
    "file_search",
    "image_generation",
    "code_interpreter",
    "computer_use_preview",
    "computer",
    "mcp",
    "tool_search",
    "programmatic_tool_calling",
  ])(
    "rejects unsupported native tool %s including additional_tools",
    (type) => {
      expect(() =>
        normalizeRequest(
          {
            model: "test",
            input: [{ type: "additional_tools", tools: [{ type }] }],
          },
          "responses",
        ),
      ).toThrowError(expect.objectContaining({ code: "unsupported_tool" }));
    },
  );
  it.each([
    { type: "input_audio", data: "x" },
    { type: "input_video", video_url: "x" },
    { type: "input_file", file_id: "file_x" },
    { type: "input_image", file_id: "file_x" },
  ])("rejects unsupported media/reference input %j", (part) => {
    expect(() =>
      normalizeRequest(
        { model: "test", input: [{ role: "user", content: [part] }] },
        "responses",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it("rejects persistence and strips only ordinary documented fields", () => {
    expect(() =>
      normalizeRequest({ model: "test", input: "x", store: true }, "responses"),
    ).toThrowError(expect.objectContaining({ code: "unsupported_parameter" }));
    const r = normalizeRequest(
      {
        model: "test",
        input: "x",
        max_output_tokens: 20,
        temperature: 1,
        top_p: 0.5,
        metadata: { a: "b" },
        safety_identifier: "x",
        user: "x",
      },
      "responses",
    );
    expect(r.ignoredParams).toEqual([
      "max_output_tokens",
      "temperature",
      "top_p",
      "metadata",
      "safety_identifier",
      "user",
    ]);
    expect(r.body.max_output_tokens).toBeUndefined();
  });
  it("rejects malformed tools, tool choice and content", () => {
    for (const input of [
      { tools: [{ type: "function", function: {} }] },
      { tool_choice: { type: "function", function: {} } },
      { messages: [{ role: "alien", content: "x" }] },
      { messages: [{ role: "user", content: [{ type: "text", text: 7 }] }] },
    ]) {
      expect(() =>
        normalizeRequest(
          {
            model: "test",
            messages: [{ role: "user", content: "x" }],
            ...input,
          },
          "chat",
        ),
      ).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });
  it("reserves encoded names and fails overlong namespace Chat names explicitly", async () => {
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          tools: [{ type: "function", function: { name: "_mpn_invalid" } }],
        },
        "chat",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          tools: [{ type: "function", function: { name: "x".repeat(65) } }],
        },
        "chat",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
    await expect(
      collectResponse(
        events(
          completed([
            {
              type: "function_call",
              id: "item",
              call_id: "call",
              namespace: "long".repeat(20),
              name: "f",
              arguments: "{}",
            },
          ]),
        ),
        "chat",
        "test",
      ),
    ).rejects.toMatchObject({ code: "unsupported_output" });
  });
  it("roundtrips actual native namespace identity via encoded Chat names", async () => {
    const item = {
      type: "custom_tool_call",
      id: "i",
      call_id: "c",
      namespace: "tools",
      name: "patch",
      input: "abc",
    };
    const chat = await collectResponse(
      events(completed([item])),
      "chat",
      "test",
    );
    const name = chat.choices[0].message.tool_calls[0].custom.name;
    expect(name).toMatch(/^_mpn_/);
    const r = normalizeRequest(
      {
        model: "test",
        messages: [
          chat.choices[0].message,
          { role: "tool", tool_call_id: "c", content: "ok" },
        ],
        tools: [{ type: "custom", custom: { name } }],
      },
      "chat",
    ).body;
    expect(r.input[0]).toMatchObject({
      call_id: "c",
      namespace: "tools",
      name: "patch",
    });
    expect(r.tools[0]).toMatchObject({
      name: "tools",
      tools: [{ name: "patch" }],
    });
    expect(() =>
      normalizeRequest(
        {
          model: "test",
          messages: [{ role: "user", content: "x" }],
          tool_choice: { type: "custom", custom: { name } },
        },
        "chat",
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported_parameter" }));
  });
});

describe("response adapters", () => {
  it.each([undefined, { includeUsage: false }, { includeUsage: true }])(
    "honors usage opt-in %j while retaining nonstream usage",
    async (options) => {
      const emitted = chunks(
        await frames(
          renderStream(
            events(
              { type: "response.created", response: finalResponse() },
              completed([
                {
                  type: "message",
                  id: "m",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "answer", annotations: [] },
                  ],
                },
              ]),
            ),
            "chat",
            "test",
            options,
          ),
        ),
      );
      const usageChunks = emitted.filter((chunk) => chunk.choices.length === 0);
      if (options?.includeUsage) {
        expect(usageChunks).toHaveLength(1);
        expect(usageChunks[0].usage).toMatchObject({
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16,
        });
        for (const chunk of emitted.filter((c) => c.choices.length))
          expect(chunk.usage).toBeNull();
      } else {
        expect(usageChunks).toHaveLength(0);
        for (const chunk of emitted) expect(chunk).not.toHaveProperty("usage");
      }
      expect(
        (await collectResponse(events(completed()), "chat", "test")).usage,
      ).toMatchObject({
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
      });
    },
  );
  it("usage opt-in cannot add a successful usage chunk or terminator after failure", async () => {
    const emitted: string[] = [];
    try {
      for await (const frame of renderStream(
        events(
          { type: "response.created", response: finalResponse() },
          {
            type: "response.output_text.delta",
            item_id: "m",
            content_index: 0,
            delta: "partial",
          },
          {
            type: "response.failed",
            response: { ...finalResponse(), status: "failed" },
          },
        ),
        "chat",
        "test",
        { includeUsage: true },
      ))
        emitted.push(frame);
      expect.fail("must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "response_failed" });
    }
    const values = chunks(emitted);
    expect(values.every((v) => v.usage === null && v.choices.length > 0)).toBe(
      true,
    );
    expect(emitted.join("")).not.toContain("[DONE]");
  });
  it("does not duplicate .done snapshots or final output text, arguments and citations", async () => {
    const f = {
      type: "function_call",
      id: "f",
      call_id: "c",
      name: "f",
      arguments: "",
    };
    const annotation = {
      type: "url_citation",
      start_index: 0,
      end_index: 2,
      title: "source",
      url: "https://example.com",
    };
    const message = {
      type: "message",
      id: "m",
      role: "assistant",
      content: [{ type: "output_text", text: "hi", annotations: [annotation] }],
    };
    const result = chunks(
      await frames(
        renderStream(
          events(
            { type: "response.created", response: finalResponse() },
            { type: "response.output_item.added", output_index: 1, item: f },
            {
              type: "response.function_call_arguments.delta",
              item_id: "f",
              output_index: 1,
              delta: "{",
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "f",
              output_index: 1,
              arguments: "{}",
            },
            {
              type: "response.output_text.delta",
              item_id: "m",
              output_index: 0,
              content_index: 0,
              delta: "h",
            },
            {
              type: "response.output_text.done",
              item_id: "m",
              output_index: 0,
              content_index: 0,
              text: "hi",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: message,
            },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: { ...f, arguments: "{}" },
            },
            completed([message, { ...f, arguments: "{}" }]),
          ),
          "chat",
          "test",
        ),
      ),
    );
    const deltas = result.flatMap((x) =>
      x.choices.map((c: JsonObject) => c.delta),
    );
    expect(deltas.map((x) => x.content ?? "").join("")).toBe("hi");
    expect(
      deltas
        .flatMap((x) => x.tool_calls ?? [])
        .map((x) => x.function?.arguments ?? "")
        .join(""),
    ).toBe("{}");
    expect(deltas.flatMap((x) => x.annotations ?? [])).toEqual([
      {
        type: "url_citation",
        url_citation: {
          start_index: 0,
          end_index: 2,
          title: "source",
          url: "https://example.com",
        },
      },
    ]);
  });
  it("rejects conflicting tool identity and disagreeing final payload before success", async () => {
    const f = {
      type: "function_call",
      id: "f",
      call_id: "c",
      name: "f",
      arguments: "",
    };
    await expect(
      frames(
        renderStream(
          events(
            { type: "response.output_item.added", output_index: 0, item: f },
            completed([{ ...f, call_id: "other", arguments: "{}" }]),
          ),
          "chat",
          "test",
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_stream" });
    await expect(
      frames(
        renderStream(
          events(
            { type: "response.output_item.added", output_index: 0, item: f },
            {
              type: "response.function_call_arguments.delta",
              item_id: "f",
              output_index: 0,
              delta: "wrong",
            },
            completed([{ ...f, arguments: "{}" }]),
          ),
          "chat",
          "test",
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_stream" });
  });
  it("retains the final native object and raw native events including nontext", async () => {
    const response = finalResponse([
      { type: "reasoning", encrypted_content: "cipher", summary: [] },
      { type: "web_search_call", id: "search", status: "completed" },
    ]);
    expect(
      await collectResponse(
        events({ type: "response.completed", response }),
        "responses",
        "test",
      ),
    ).toEqual(response);
    const value = {
      type: "response.output_text.delta",
      delta: "hello",
      output_index: 0,
      item_id: "m",
      content_index: 0,
      sequence_number: 2,
    };
    const result = await frames(
      renderStream(
        events(value, { type: "response.completed", response }),
        "responses",
        "test",
      ),
    );
    expect(result[0]).toBe(
      `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
    );
    expect(result.join("")).not.toContain("[DONE]");
  });
  it("streams interleaved text/function/custom calls with stable IDs, final-only arguments, refusal and usage", async () => {
    const f = {
      type: "function_call",
      id: "item_f",
      call_id: "call_f",
      name: "f",
      arguments: "",
      status: "in_progress",
    };
    const c = {
      type: "custom_tool_call",
      id: "item_c",
      call_id: "call_c",
      name: "c",
      input: "",
      status: "in_progress",
    };
    const out = [
      {
        type: "message",
        id: "m",
        role: "assistant",
        content: [
          { type: "output_text", text: "hi", annotations: [] },
          { type: "refusal", refusal: "no" },
        ],
      },
      { ...f, arguments: '{"a":1}', status: "completed" },
      { ...c, input: "patch", status: "completed" },
    ];
    const result = await frames(
      renderStream(
        events(
          { type: "response.created", response: finalResponse() },
          { type: "response.output_item.added", output_index: 4, item: f },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: "m",
            content_index: 0,
            delta: "hi",
          },
          { type: "response.output_item.added", output_index: 7, item: c },
          {
            type: "response.function_call_arguments.delta",
            output_index: 4,
            item_id: "item_f",
            delta: '{"a":',
          },
          {
            type: "response.refusal.delta",
            output_index: 0,
            item_id: "m",
            content_index: 1,
            delta: "no",
          },
          completed(out),
        ),
        "chat",
        "test",
        { includeUsage: true },
      ),
    );
    const values = chunks(result);
    const deltas = values.flatMap((v) =>
      v.choices.map((x: JsonObject) => x.delta),
    );
    const calls = deltas.flatMap((x) => x.tool_calls ?? []);
    expect(calls.filter((x) => x.id).map((x) => [x.index, x.id])).toEqual([
      [0, "call_f"],
      [1, "call_c"],
    ]);
    expect(
      calls
        .filter((x) => x.index === 0)
        .map((x) => x.function?.arguments ?? "")
        .join(""),
    ).toBe('{"a":1}');
    expect(
      calls
        .filter((x) => x.index === 1)
        .map((x) => x.custom?.input ?? "")
        .join(""),
    ).toBe("patch");
    expect(deltas.map((x) => x.content ?? "").join("")).toBe("hi");
    expect(deltas.map((x) => x.refusal ?? "").join("")).toBe("no");
    expect(values.at(-2).choices[0].finish_reason).toBe("tool_calls");
    expect(values.at(-1).usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(result.at(-1)).toBe("data: [DONE]\n\n");
    expect(result.join("")).not.toContain("item_f");
  });
  it("collects complete-only text/refusal/citations/tools without inventing reasoning content", async () => {
    const annotation = {
      type: "url_citation",
      start_index: 1,
      end_index: 4,
      title: "source",
      url: "https://example.com",
    };
    const response = await collectResponse(
      events(
        completed([
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "private summary" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "answer",
                annotations: [annotation],
              },
              { type: "refusal", refusal: "no" },
            ],
          },
          {
            type: "function_call",
            id: "item",
            call_id: "call",
            name: "f",
            arguments: '{"done":true}',
          },
        ]),
      ),
      "chat",
      "test",
    );
    expect(response.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "answer",
        refusal: "no",
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              start_index: 1,
              end_index: 4,
              title: "source",
              url: "https://example.com",
            },
          },
        ],
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "f", arguments: '{"done":true}' },
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain("private summary");
  });
  it.each(["responses", "chat"] as const)(
    "rejects premature EOF for %s",
    async (format) => {
      await expect(
        collectResponse(
          events({ type: "response.output_text.delta", delta: "partial" }),
          format,
          "test",
        ),
      ).rejects.toMatchObject({ code: "stream_interrupted" });
      await expect(
        frames(
          renderStream(
            events({
              type: "response.output_text.delta",
              delta: "partial",
              item_id: "m",
              content_index: 0,
            }),
            format,
            "test",
          ),
        ),
      ).rejects.toMatchObject({ code: "stream_interrupted" });
    },
  );
  it.each(["response.failed", "response.incomplete", "error"])(
    "throws %s after deltas without a normal success terminator",
    async (type) => {
      const emitted: string[] = [];
      try {
        for await (const frame of renderStream(
          events(
            {
              type: "response.output_text.delta",
              delta: "partial",
              item_id: "m",
              content_index: 0,
            },
            {
              type,
              response: {
                ...finalResponse(),
                status: type === "response.failed" ? "failed" : "incomplete",
                error: { code: "limit", message: "Limit" },
                incomplete_details: { reason: "max_output_tokens" },
              },
              code: "limit",
              message: "Limit",
            },
          ),
          "chat",
          "test",
        ))
          emitted.push(frame);
        expect.fail("must throw");
      } catch (e) {
        expect(e).toMatchObject({ status: 502 });
      }
      expect(emitted.join("")).toContain("partial");
      expect(emitted.join("")).not.toContain("[DONE]");
      expect(emitted.join("")).not.toContain('"finish_reason":"stop"');
    },
  );
  it("rejects noncompleted status even on a completed event and unrepresentable Chat output", async () => {
    await expect(
      collectResponse(
        events({
          type: "response.completed",
          response: { ...finalResponse(), status: "incomplete" },
        }),
        "responses",
        "test",
      ),
    ).rejects.toMatchObject({ code: "response_incomplete" });
    await expect(
      collectResponse(
        events(
          completed([{ type: "image_generation_call", result: "base64" }]),
        ),
        "chat",
        "test",
      ),
    ).rejects.toMatchObject({ code: "unsupported_output" });
  });
});
