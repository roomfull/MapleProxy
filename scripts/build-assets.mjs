import { copyFile, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/scripts/", import.meta.url), { recursive: true });
await copyFile(
  new URL("dpapi.ps1", import.meta.url),
  new URL("../dist/scripts/dpapi.ps1", import.meta.url),
);
for (const name of ["LICENSE", "LICENSING.md", "LICENSE-SIWC", "THIRD_PARTY_NOTICES.md"])
  await copyFile(
    new URL(`../${name}`, import.meta.url),
    new URL(`../dist/${name}`, import.meta.url),
  );
// TypeScript also emits the imported vendored sources under dist/vendor/siwc/.
await mkdir(new URL("../dist/vendor/siwc/", import.meta.url), { recursive: true });
for (const name of ["LICENSE", "PROVENANCE.md", "THIRD_PARTY_NOTICES.md", "dependency-inventory.json"])
  await copyFile(
    new URL(`../vendor/siwc/${name}`, import.meta.url),
    new URL(`../dist/vendor/siwc/${name}`, import.meta.url),
  );
