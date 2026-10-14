import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const pairs = [
  ...["LICENSE", "LICENSING.md", "LICENSE-SIWC", "THIRD_PARTY_NOTICES.md"].map(
    (name) => [name, `dist/${name}`],
  ),
  ...[
    "LICENSE",
    "PROVENANCE.md",
    "THIRD_PARTY_NOTICES.md",
    "dependency-inventory.json",
  ].flatMap((name) => [
    [`vendor/siwc/${name}`, `vendor/siwc/dist/${name}`],
    [`vendor/siwc/${name}`, `dist/vendor/siwc/${name}`],
  ]),
];

for (const [source, output] of pairs) {
  try {
    const [expected, actual] = await Promise.all([
      readFile(new URL(source, root)),
      readFile(new URL(output, root)),
    ]);
    if (!expected.equals(actual)) throw new Error("Contents differ.");
  } catch {
    console.error(`License artifact missing or different: ${output}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode)
  console.log(`Verified ${pairs.length} license and notice artifacts.`);
