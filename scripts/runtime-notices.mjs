import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
let notices = "# MapleProxy installed runtime dependency notices\n\n";
notices +=
  "SIWC source and noncommercial license: vendor/siwc/LICENSE and LICENSE-SIWC.\n";
notices +=
  "Original upstream notice inventory is preserved at vendor/siwc/THIRD_PARTY_NOTICES.md.\n";
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || entry.dev || entry.link) continue;
  const files = await readdir(join(root, path));
  const license = files.find((name) => /^licen[sc]e(?:\..*)?$/i.test(name));
  notices += `\n## ${path.slice("node_modules/".length)} ${entry.version}\n\n`;
  if (license) notices += await readFile(join(root, path, license), "utf8");
  else if (
    path === "node_modules/abstract-logging" &&
    entry.version === "2.0.1"
  ) {
    // This exact upstream version ships only a README link to its MIT license.
    const metadata = JSON.parse(
      await readFile(join(root, path, "package.json"), "utf8"),
    );
    if (metadata.license !== "MIT")
      throw new Error(`Changed runtime license: ${path}`);
    notices += await readFile(
      join(root, "scripts/licenses/abstract-logging.LICENSE"),
      "utf8",
    );
  } else throw new Error(`Missing runtime license: ${path}`);
  notices += "\n";
}
await writeFile(
  join(root, "THIRD_PARTY_NOTICES.md"),
  notices.replace(/[\t ]+$/gm, "").trimEnd() + "\n",
);
