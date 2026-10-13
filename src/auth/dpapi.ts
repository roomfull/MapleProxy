import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CredentialEncryption } from "../../vendor/siwc/src/types.js";
import { AppError } from "../shared/errors.js";
export function createDpapiEncryption(
  options: { platform?: NodeJS.Platform } = {},
): CredentialEncryption {
  const platform = options.platform ?? process.platform;
  const failure = () =>
    new AppError(
      503,
      "storage_encryption_unavailable",
      "Windows DPAPI credential protection is unavailable. Saved credentials have been preserved.",
    );
  async function run(
    operation: "encrypt" | "decrypt",
    bytes: Uint8Array,
  ): Promise<Buffer> {
    if (platform !== "win32") throw failure();
    return new Promise((resolve, reject) => {
      // Build copies this fixed helper to dist/scripts for installed production use.
      const path = fileURLToPath(
        new URL("../../scripts/dpapi.ps1", import.meta.url),
      );
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path,
        ],
        { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(failure());
      }, 15000);
      timer.unref();
      child.stdout.on("data", (data: Buffer) => {
        size += data.length;
        if (size > 4 * 1024 * 1024) {
          child.kill();
          reject(failure());
        } else chunks.push(data);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", () => {
        clearTimeout(timer);
        reject(failure());
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("ascii").trim();
        if (
          code !== 0 ||
          !output ||
          Buffer.from(output, "base64").toString("base64") !== output
        ) {
          reject(failure());
          return;
        }
        resolve(Buffer.from(output, "base64"));
      });
      child.stdin.end(
        `${operation}\n${Buffer.from(bytes).toString("base64")}\n`,
      );
    });
  }
  return {
    id: "windows-dpapi-currentuser-v1",
    isAvailable: () => platform === "win32",
    encrypt: (s) => run("encrypt", Buffer.from(s, "utf8")),
    decrypt: async (b) => (await run("decrypt", b)).toString("utf8"),
  };
}
