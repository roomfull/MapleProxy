import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/protocol/normalize.js";
import { collectResponse, renderStream } from "../src/protocol/events.js";
import { flatNamespace } from "../src/protocol/chat.js";
import type { JsonObject } from "../src/auth/runtime.js";

async function* events(...values: JsonObject[]) {
  yield* values;
}
const call = (id = "a", name = "read", argumentsValue = '{"x":null}') => ({
  type: "function_call",
  id: `item_${id}`,
  call_id: id,
  name,
  namespace: flatNamespace(name),
  arguments: argumentsValue,
});
const done = (output: JsonObject[]) => ({
  type: "response.completed",
  response: {
    id: "response",
    created_at: 1,
    model: "synthetic",
    status: "completed",
    output,
  },
});
async function chunks(source: AsyncIterable<string>) {
  const result: JsonObject[] = [];
  for await (const frame of source)
    if (!frame.includes("[DONE]"))
      result.push(JSON.parse(frame.split("data: ")[1]!.trim()));
  return result;
}
const base = {
  model: "synthetic",
  messages: [{ role: "user", content: "go" }],
};

describe("tool roundtrip", () => {
  it.each([undefined, null, false, true])(
    "keeps Chat strict=%s semantics",
    (strict) => {
      const request = normalizeRequest(
        {
          ...base,
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: {
                  type: "object",
                  properties: { x: { default: null } },
                },
                ...(strict === undefined ? {} : { strict }),
              },
            },
          ],
        },
        "chat",
      );
      expect(request.body.tools[0].tools[0].strict).toBe(strict ?? false);
      expect(
        request.body.tools[0].tools[0].parameters.properties.x.default,
      ).toBeNull();
      expect(request.renderOptions.responseContext).toBe(
        request.responseContext,
      );
    },
  );
  it("keeps native strict defaults unchanged", () => {
    const request = normalizeRequest(
      { model: "m", input: "x", tools: [{ type: "function", name: "read" }] },
      "responses",
    );
    expect(request.body.tools[0].tools[0]).not.toHaveProperty("strict");
  });
  it("restores request-local names and preserves parallel second-round order", async () => {
    const first = normalizeRequest(
      {
        ...base,
        tools: ["read", "write"].map((name) => ({
          type: "function",
          function: { name },
        })),
      },
      "chat",
    );
    // Upstream may omit namespace for a unique requested name.
    const output = [call("a", "read"), call("b", "write")].map(
      ({ namespace: _namespace, ...item }) => item,
    );
    const response = await collectResponse(
      events(done(output)),
      "chat",
      "synthetic",
      first.renderOptions,
    );
    expect(
      response.choices[0].message.tool_calls.map(
        (x: JsonObject) => x.function.name,
      ),
    ).toEqual(["read", "write"]);
    expect(first.responseContext.toolNames).toEqual(
      ["read", "write"].map((name) => ({
        name,
        clientName: name,
        namespace: flatNamespace(name),
      })),
    );
    const next = normalizeRequest(
      {
        model: "m",
        messages: [
          base.messages[0],
          response.choices[0].message,
          { role: "tool", tool_call_id: "b", content: "second" },
          { role: "tool", tool_call_id: "a", content: "first" },
        ],
      },
      "chat",
    );
    expect(
      next.body.input
        .slice(1)
        .map((x: JsonObject) => [x.type, x.call_id, x.arguments ?? x.output]),
    ).toEqual([
      ["function_call", "a", '{"x":null}'],
      ["function_call", "b", '{"x":null}'],
      ["function_call_output", "b", "second"],
      ["function_call_output", "a", "first"],
    ]);
  });
  it("restores encoded names when namespace is missing on both response forms", async () => {
    const encoded =
      "_mpn_" +
      Buffer.from(JSON.stringify(["ns", "read"])).toString("base64url");
    const request = normalizeRequest(
      { ...base, tools: [{ type: "function", function: { name: encoded } }] },
      "chat",
    );
    const item = { ...call(), namespace: undefined };
    const response = await collectResponse(
      events(done([item])),
      "chat",
      "m",
      request.renderOptions,
    );
    expect(response.choices[0].message.tool_calls[0].function.name).toBe(
      encoded,
    );
    const stream = await chunks(
      renderStream(events(done([item])), "chat", "m", request.renderOptions),
    );
    expect(
      stream.flatMap((x) => x.choices[0].delta.tool_calls ?? [])[0].function
        .name,
    ).toBe(encoded);
    expect(normalizeRequest(base, "chat").responseContext.toolNames).toEqual(
      [],
    );
  });
  it("restores a history-only encoded name when namespace is absent upstream", async () => {
    const name =
      "_mpn_" +
      Buffer.from(JSON.stringify(["ns", "read"])).toString("base64url");
    const request = normalizeRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "old",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "old", content: "ok" },
        ],
      },
      "chat",
    );
    const result = await collectResponse(
      events(done([{ ...call(), namespace: undefined }])),
      "chat",
      "m",
      request.renderOptions,
    );
    expect(result.choices[0].message.tool_calls[0].function.name).toBe(name);
  });
  it.each(["chat", "responses"] as const)(
    "normalizes whitespace function arguments but preserves custom input on %s",
    (format) => {
      const native = [
        call("a", "read", " \n\t"),
        { type: "custom_tool_call", call_id: "b", name: "patch", input: " \n" },
        { type: "function_call_output", call_id: "a", output: "ok" },
        { type: "custom_tool_call_output", call_id: "b", output: "ok" },
      ];
      const messages = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "read", arguments: " \n\t" },
            },
            {
              id: "b",
              type: "custom",
              custom: { name: "patch", input: " \n" },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "ok" },
        { role: "tool", tool_call_id: "b", content: "ok" },
      ];
      const result = normalizeRequest(
        {
          model: "m",
          ...(format === "chat" ? { messages } : { input: native }),
        },
        format,
      );
      expect(result.body.input[0].arguments).toBe("{}");
      expect(result.body.input[1].input).toBe(" \n");
    },
  );
  it.each(["chat", "responses"] as const)(
    "rejects missing/duplicate/unpaired results on %s",
    (format) => {
      const nativeCall = call();
      const output = {
        type: "function_call_output",
        call_id: "a",
        output: "ok",
      };
      const chatCall = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      };
      const chatOutput = { role: "tool", tool_call_id: "a", content: "ok" };
      const histories =
        format === "chat"
          ? [
              [chatCall],
              [chatCall, chatOutput, chatOutput],
              [chatOutput],
              [chatCall, chatCall, chatOutput],
            ]
          : [
              [nativeCall],
              [nativeCall, output, output],
              [output],
              [nativeCall, nativeCall, output],
              [nativeCall, { ...output, type: "custom_tool_call_output" }],
            ];
      for (const history of histories)
        expect(() =>
          normalizeRequest(
            { model: "m", [format === "chat" ? "messages" : "input"]: history },
            format,
          ),
        ).toThrowError(
          expect.objectContaining({ status: 400, code: "invalid_request" }),
        );
    },
  );
  it("preserves native named outputs and local tools while rejecting ambiguous named pairing", () => {
    const native = [
      {
        type: "function_call_output",
        name: "notice",
        output: "unpaired named",
      },
      { type: "shell_call", call_id: "s", action: { commands: ["pwd"] } },
      { type: "shell_call_output", call_id: "s", output: [] },
    ];
    expect(
      normalizeRequest({ model: "m", input: native }, "responses").body.input,
    ).toMatchObject(native);
    expect(() =>
      normalizeRequest(
        {
          model: "m",
          input: [
            call("a"),
            call("b"),
            { type: "function_call_output", name: "read", output: "ambiguous" },
          ],
        },
        "responses",
      ),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it("reports source Chat paths for missing and duplicate tool results", () => {
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "call now",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
    ];
    expect(() =>
      normalizeRequest({ model: "m", messages }, "chat"),
    ).toThrowError(
      expect.objectContaining({ param: "messages[1].tool_calls[0]" }),
    );
    const output = { role: "tool", tool_call_id: "a", content: "ok" };
    expect(() =>
      normalizeRequest(
        { model: "m", messages: [...messages, output, output] },
        "chat",
      ),
    ).toThrowError(
      expect.objectContaining({ param: "messages[3].tool_call_id" }),
    );
  });
  it("records only paths for strict and empty-arguments normalization", () => {
    const request = normalizeRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: { name: "read", arguments: " \n" },
              },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "output-secret" },
        ],
        tools: [{ type: "function", function: { name: "read" } }],
      },
      "chat",
    );
    expect(request.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "messages[0].tool_calls[0].function.arguments",
          action: "normalized",
          reason: "protocol_conversion",
        },
        {
          path: "tools[0].function.strict",
          action: "normalized",
          reason: "protocol_conversion",
        },
      ]),
    );
    expect(JSON.stringify(request.diagnostics)).not.toContain("output-secret");
  });
});

describe("legacy functions", () => {
  const legacy = {
    ...base,
    functions: [{ name: "read", parameters: { type: "object" } }],
    function_call: { name: "read" },
  };
  it("converts legacy choice and returns legacy nonstream response for roundtrip", async () => {
    const first = normalizeRequest(legacy, "chat");
    expect(first.body.tools[0].tools[0]).toMatchObject({
      type: "function",
      name: "read",
      strict: false,
    });
    expect(first.body.tool_choice).toEqual({ type: "function", name: "read" });
    expect(first.body).not.toHaveProperty("functions");
    expect(first.body).not.toHaveProperty("function_call");
    const result = await collectResponse(
      events(done([call()])),
      "chat",
      "m",
      first.renderOptions,
    );
    expect(result.choices[0].message.function_call).toEqual({
      name: "read",
      arguments: '{"x":null}',
    });
    expect(result.choices[0].message).not.toHaveProperty("tool_calls");
    expect(result.choices[0].finish_reason).toBe("function_call");
    const messages = [
      base.messages[0],
      result.choices[0].message,
      { role: "function", name: "read", content: "ok" },
    ];
    const second = normalizeRequest({ ...legacy, messages }, "chat");
    expect(second.body.input.slice(1)).toMatchObject([
      { type: "function_call", name: "read", arguments: '{"x":null}' },
      { type: "function_call_output", output: "ok" },
    ]);
    expect(second.body.input[1].call_id).toBe(second.body.input[2].call_id);
    expect(
      normalizeRequest({ ...legacy, messages }, "chat").body.input[1].call_id,
    ).toBe(second.body.input[1].call_id);
  });
  it.each(["auto", "none"])("converts legacy choice %s", (value) => {
    expect(
      normalizeRequest({ ...legacy, function_call: value }, "chat").body
        .tool_choice,
    ).toBe(value);
  });
  it("streams legacy name and argument deltas without modern fields", async () => {
    const first = normalizeRequest(legacy, "chat");
    const output = call("a", "read", '{"x":null}');
    const stream = await chunks(
      renderStream(
        events(
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...output, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: output.id,
            delta: '{"x":',
          },
          {
            type: "response.function_call_arguments.done",
            item_id: output.id,
            arguments: output.arguments,
          },
          done([output]),
        ),
        "chat",
        "m",
        first.renderOptions,
      ),
    );
    expect(stream.flatMap((x) => x.choices).at(-1)?.finish_reason).toBe(
      "function_call",
    );
    expect(
      stream
        .map((x) => x.choices[0].delta.function_call?.arguments ?? "")
        .join(""),
    ).toBe(output.arguments);
    expect(
      stream.find((x) => x.choices[0].delta.function_call?.name)?.choices[0]
        .delta.function_call.name,
    ).toBe("read");
    expect(JSON.stringify(stream)).not.toContain("tool_calls");
  });
  it.each(["chat", "responses"] as const)(
    "rejects inappropriate legacy fields on %s",
    (format) => {
      const cases =
        format === "responses"
          ? [{ model: "m", input: "x", functions: legacy.functions }]
          : [
              {
                ...legacy,
                tools: [{ type: "function", function: { name: "other" } }],
              },
              { ...legacy, tool_choice: "auto" },
              {
                ...legacy,
                messages: [
                  {
                    role: "assistant",
                    function_call: { name: "read", arguments: "{}" },
                    tool_calls: [],
                  },
                ],
              },
              {
                ...legacy,
                messages: [
                  { role: "function", name: "read", content: "orphan" },
                ],
              },
              {
                ...legacy,
                messages: [
                  {
                    role: "assistant",
                    function_call: { name: "read", arguments: "{}" },
                  },
                  { role: "function", name: "write", content: "wrong" },
                ],
              },
            ];
      for (const value of cases)
        expect(() => normalizeRequest(value, format)).toThrowError(
          expect.objectContaining({ status: 400 }),
        );
    },
  );
  it("rejects parallel or custom legacy output instead of dropping calls", async () => {
    const request = normalizeRequest(legacy, "chat");
    for (const output of [
      [call("a"), call("b")],
      [{ type: "custom_tool_call", call_id: "a", name: "read", input: "x" }],
    ]) {
      await expect(
        collectResponse(
          events(done(output)),
          "chat",
          "m",
          request.renderOptions,
        ),
      ).rejects.toMatchObject({ code: "unsupported_output" });
      await expect(
        chunks(
          renderStream(
            events(done(output)),
            "chat",
            "m",
            request.renderOptions,
          ),
        ),
      ).rejects.toMatchObject({ code: "unsupported_output" });
    }
  });
  it("cleans legacy optional nulls without touching schemas and preserves diagnostics on pairing failure", () => {
    const request = normalizeRequest(
      {
        ...legacy,
        functions: [
          { name: "read", description: null, parameters: null, strict: null },
        ],
      },
      "chat",
    );
    expect(request.body.tools[0].tools[0]).toEqual({
      type: "function",
      name: "read",
      strict: false,
    });
    expect(() =>
      normalizeRequest(
        {
          ...legacy,
          messages: [
            { role: "user", name: "metadata-secret", content: "go" },
            {
              role: "assistant",
              function_call: { name: "read", arguments: "{}" },
            },
            { role: "function", name: "wrong", content: "output-secret" },
          ],
        },
        "chat",
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          {
            path: "messages[0].name",
            action: "filtered",
            reason: "client_metadata",
          },
          {
            path: "messages[1].function_call",
            action: "normalized",
            reason: "protocol_conversion",
          },
        ]),
      }),
    );
  });
  it("keeps diagnostic paths on the original legacy fields", () => {
    const request = normalizeRequest(
      {
        ...legacy,
        messages: [
          {
            role: "assistant",
            function_call: { name: "read", arguments: " " },
          },
          { role: "function", name: "read", content: "ok" },
        ],
      },
      "chat",
    );
    expect(request.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "functions[0].strict",
          action: "normalized",
          reason: "protocol_conversion",
        },
        {
          path: "messages[0].function_call.arguments",
          action: "normalized",
          reason: "protocol_conversion",
        },
      ]),
    );
    expect(
      request.diagnostics.some(
        (x) => x.path.startsWith("tools") || x.path.includes("tool_calls"),
      ),
    ).toBe(false);
  });
  it("normalizes empty returned function arguments in nonstream and streaming", async () => {
    const request = normalizeRequest(legacy, "chat");
    const output = call("a", "read", " \n");
    const response = await collectResponse(
      events(done([output])),
      "chat",
      "m",
      request.renderOptions,
    );
    expect(response.choices[0].message.function_call.arguments).toBe("{}");
    const stream = await chunks(
      renderStream(
        events(
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...output, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: output.id,
            delta: " \n",
          },
          done([output]),
        ),
        "chat",
        "m",
        request.renderOptions,
      ),
    );
    expect(
      stream
        .map((x) => x.choices[0].delta.function_call?.arguments ?? "")
        .join(""),
    ).toBe("{}");
  });
  it("accepts repeated blank completed snapshots and preserves nonblank whitespace deltas", async () => {
    const request = normalizeRequest(legacy, "chat");
    for (const value of [" \n", ' \n{"x":1} ']) {
      const output = call("a", "read", value);
      const stream = await chunks(
        renderStream(
          events(
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...output, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: output.id,
              delta: " \n",
            },
            {
              type: "response.function_call_arguments.done",
              item_id: output.id,
              arguments: value,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: output,
            },
            done([output]),
          ),
          "chat",
          "m",
          request.renderOptions,
        ),
      );
      expect(
        stream
          .map((x) => x.choices[0].delta.function_call?.arguments ?? "")
          .join(""),
      ).toBe(value.trim() ? value : "{}");
    }
  });
});
