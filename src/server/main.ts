import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { createAccountRuntime } from "../auth/runtime.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535.");
// Resolve assets against this installation, regardless of the caller's cwd.
const moduleRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const projectRoot =
  basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot;
const dataDir = resolve(
  process.env.MAPLEPROXY_DATA_DIR ?? resolve(projectRoot, "data"),
);
const app = await createApp({
  runtime: createAccountRuntime({ dataDir }),
  dataDir,
  port,
  webDir: resolve(projectRoot, "web/dist"),
});
await app.listen({ host: "127.0.0.1", port });
console.log(`MapleProxy: http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
