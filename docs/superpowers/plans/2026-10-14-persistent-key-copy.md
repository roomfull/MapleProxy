# Persistent access-key copying implementation plan

> **For agentic workers:** Use subagent-driven-development to implement this confirmed plan task by task.

**Goal:** New access keys remain copyable after refresh, relogin and service restart.
**Architecture:** Keep authentication hashes and store DPAPI CurrentUser encrypted originals. Return masked metadata from lists and retrieve originals only through an administrator POST.
**Tech Stack:** TypeScript, Fastify, React, Vitest, existing CredentialEncryption and Windows DPAPI.

## Global Constraints
- Follow the user-approved design. Local JSON version remains 1; no Redis or production dependencies.
- DPAPI is the production default; tests inject CredentialEncryption.
- Optional persisted encryptedSecret (Base64 ciphertext) and encryptionId; retain hashes.
- List and creation KeyView contain only id, name, prefix, createdAt, canCopy. Explicit whitelist, never spread stored records.
- Encryption must complete before atomic update; unavailable/failing encryption creates no record, never plaintext fallback.
- POST /api/admin/keys/:id/secret returns { secret: string }; administrator session, Origin, CSRF and no-store required. Inference keys are not admin credentials.
- Missing/revoked: 404; legacy without original: 409; unavailable/decryption failure/corruption/hash mismatch: 503; preserve data.
- Revocation removes record, hash and ciphertext. Existing hash-only keys retain authentication and revocation.
- Original fetched by list-copy is used only for clipboard, never persistent browser storage, request examples or logs.
- Copy button before revoke; pending “复制中…” disables duplicates. Success only after clipboard write; failures remain retryable.
- Creation card “密钥已创建，可随时从列表复制”; hide button “隐藏密钥”.
- Disabled legacy button with visible “旧密钥未保存完整值，请新建密钥后复制。”
- Document copying across restarts, legacy limits, original Windows-user DPAPI dependency.
- Run npm test, npm run typecheck, npm run build; real DPAPI roundtrip, desktop and narrow visual checks, clipboard-denial verification.

### Task 1: Storage and protected retrieval
**Files:** src/server/security.ts, src/server/app.ts, src/server/routes.ts, tests/security.test.ts, tests/server.test.ts, tests/dpapi.test.ts, tests/helpers.ts, other existing key-creation test fixtures.
**Interfaces:** SecurityStore(dataDir: string, encryption?: CredentialEncryption); getKeySecret(id: string): Promise<string>; AppOptions.encryption?: CredentialEncryption; KeyView.canCopy: boolean.
- [x] Write failing storage tests: restore another store then getKeySecret equals created value; disk excludes literal and Base64 plaintext; whitelist keys exactly; legacy 409 but authenticates; revoke 404 and fails auth; encryption unavailable/throws leaves no record; malformed ciphertext, wrong encryptionId and wrong decrypted hash return 503 while good keys work.
- [x] Write failing HTTP tests for create/list/relogin/restart retrieval and inference auth. Test unauthenticated, expired (fake Date.now), inference-only bearer, bad/missing Origin, bad/missing CSRF, GET not supported. Check no-store on success/errors and no leaked sensitive data.
- [x] Run focused tests before implementation and record expected failure evidence.
- [x] Implement existing-provider injection, atomic encrypted creation, explicit views, hash-verified decryption and protected route. Map encryption errors to safe AppError 503 without provider exception contents.
- [x] Inject a real reversible test cipher into every routine key-creation fixture so tests do not call DPAPI. Add actual Windows store integration with default provider and disk checks.
- [x] Run focused tests and typecheck. Self-review, commit task files; report red/green evidence and residuals.

Example acceptance:
```ts
const created = await store.createKey("editor");
expect(await new SecurityStore(dir, encryption).getKeySecret(created.key.id)).toBe(created.secret);
expect(Object.keys((await store.listKeys())[0]!).sort()).toEqual(["canCopy", "createdAt", "id", "name", "prefix"].sort());
```

### Task 2: Copy interaction and documentation
**Files:** web/src/types.ts, web/src/panels.tsx, web/src/App.tsx, web/src/style.css as needed, tests/web-view.test.ts, tests/web-api.test.ts (and focused interaction tests if needed), README.md, docs/verification.md.
**Interfaces:** consume Key.canCopy and protected retrieval; Keys.onCopyKey: (key: Key) => void; use existing ApiClient and notices.
- [x] Write failing render/client/interaction tests for copyable and legacy rows, pending disabled button, card wording and clipboard rejection without success. Protect request examples from fetched originals.
- [x] Run focused tests, record RED.
- [x] Implement callback passing row ID to protected POST and awaiting clipboard. Use synchronous guard if necessary to block duplicate clicks before React rerender; keep result ephemeral.
- [x] Implement visible legacy explanation, copy-before-revoke actions and responsive wrapping.
- [x] Update README and verification evidence with actual tested facts and DPAPI user/environment dependency.
- [x] Run focused tests and final npm test/typecheck/build. Check desktop and narrow layouts using built output and synthetic data only.
- [x] Self-review, commit changes, report test and visual evidence.

Example client contract:
```ts
const { secret } = await api.request<{ secret: string }>(`/keys/${encodeURIComponent(key.id)}/secret`, "POST");
await navigator.clipboard.writeText(secret);
// Only now report success.
```
