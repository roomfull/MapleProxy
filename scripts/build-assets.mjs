import { copyFile, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/scripts/", import.meta.url), { recursive: true });
await copyFile(
  new URL("dpapi.ps1", import.meta.url),
  new URL("../dist/scripts/dpapi.ps1", import.meta.url),
);
for (const name of ["LICENSE-SIWC", "THIRD_PARTY_NOTICES.md"])
  await copyFile(
    new URL(`../${name}`, import.meta.url),
    new URL(`../dist/${name}`, import.meta.url),
  );
