import OpenAI from "openai";

if (!process.env.MAPLEPROXY_API_KEY)
  throw new Error(
    "Set MAPLEPROXY_API_KEY through a secure local prompt first.",
  );
const client = new OpenAI({
  apiKey: process.env.MAPLEPROXY_API_KEY,
  baseURL: process.env.MAPLEPROXY_BASE_URL ?? "http://127.0.0.1:8317/v1",
  maxRetries: 0,
  logLevel: "off",
});
const model = (await client.models.list()).data[0]?.id;
if (!model) throw new Error("No model is available for the selected account.");
const chat = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "hello" }],
});
console.log(chat.choices[0]?.message.content);
const response = await client.responses.create({ model, input: "hello" });
console.log(response.output_text);
