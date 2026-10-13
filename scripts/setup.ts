import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecurityStore } from "../src/server/security.js";

function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error(
      "非交互终端请使用 --password-stdin，通过标准输入提供密码。",
    );
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolvePassword(value);
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 1025) value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
async function stdinPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 4096) throw new Error("密码输入过长。");
    chunks.push(Buffer.from(chunk));
  }
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (/[\r\n]/.test(password)) throw new Error("密码应为单行文本。");
  return password;
}
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--password-stdin", "--reset"].includes(arg)))
    throw new Error(
      "仅支持 --password-stdin 和 --reset；请勿通过命令行参数提供密码。",
    );
  const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const root =
    basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot;
  const dataDir = resolve(
    process.env.MAPLEPROXY_DATA_DIR ?? resolve(root, "data"),
  );
  const store = new SecurityStore(dataDir);
  if ((await store.configured()) && !args.includes("--reset"))
    throw new Error(
      "管理密码已设置。如需重置，请明确使用 --reset；当前管理会话将失效。",
    );
  const password = args.includes("--password-stdin")
    ? await stdinPassword()
    : await hidden("管理密码（至少 6 个字符，输入隐藏）：");
  if (
    !args.includes("--password-stdin") &&
    password !== (await hidden("再次输入管理密码："))
  )
    throw new Error("两次输入不一致。");
  await store.setPassword(password);
  console.log("管理密码已保存。请打开本机控制台登录。");
} catch (error) {
  console.error(error instanceof Error ? error.message : "密码设置失败。");
  process.exitCode = 1;
}
