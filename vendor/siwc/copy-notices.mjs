// Added by MapleProxy for this modified DevKit; licensed under the accompanying
// DevKit Noncommercial License. See PROVENANCE.md.
import { copyFile } from "node:fs/promises";
for (const name of [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "PROVENANCE.md",
  "dependency-inventory.json",
])
  await copyFile(
    new URL(name, import.meta.url),
    new URL(`dist/${name}`, import.meta.url),
  );
