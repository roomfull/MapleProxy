# MapleProxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working local Windows SIWC model gateway and Chinese browser dashboard.

**Architecture:** One Fastify process hosts API and built React UI. Pinned official SIWC runtime owns credential lifecycle; profile-specific authenticated streaming is exposed only server-side. A separate protocol adapter converts Chat Completions and preserves Responses; local security owns admin sessions and downstream keys.

**Tech Stack:** Node.js >=22.17, TypeScript strict ESM, Fastify 5, React, Vite compatible with Node 22.17, Vitest, official OpenAI SDK, official SIWC workspace. npm lockfile.

## Global Constraints

- Windows local personal use; bind 127.0.0.1 only; never put credentials in frontend, logs, URLs, or command-line arguments.
- Extend official DevKit commit 0a36fefeb913055c8c7a1a29b63d82b96b2e841a, retain license and mark modified vendor files.
- Upstream https://api.openai.com/v1/responses with store:false and stream:true; no private ChatGPT backend APIs.
- Multiple accounts with manual default; snapshot account per request; default switch affects new requests; disable/logout aborts that account; no automatic replay or fallback account.
- Separate management password and downstream API keys. Windows DPAPI CurrentUser; no plaintext credential fallback. Local versioned atomic JSON; no Redis.
- Support all documented SIWC HTTP inference capabilities through Responses; faithfully map representable Chat Completions capabilities. Explicit errors for unsupported functionality.
- Compatibility mode filters known unsupported ordinary parameters with X-MapleProxy-Ignored-Params and activity metadata. Never promise max_tokens is enforced.
- No quota display. Actual limit error and official usage link only.
- Tests first for meaningful behavior; record RED/GREEN evidence. Do not call real OpenAI in automated tests.
- Execute on codex/mapleproxy in this initially empty, dedicated checkout. No user changes exist to isolate; do not create another checkout.

## File layout and contracts

Root package.json, tsconfig.json, vitest.config.ts; vendor/siwc contains pinned local package with license, provenance, original tests if present. src/shared/errors.ts owns AppError; src/auth/ owns DPAPI and AccountRuntime. src/protocol/ owns normalization/rendering. src/server/ owns HTTP/security/activity/static assets. web/ owns React UI. scripts/ owns CLI and DPAPI helper. Tests under tests/. npm scripts: test, typecheck, build, dev, dev:web, start, setup. Production server resolves web/dist relative to installation, not arbitrary cwd.

Use this shared contract (implement and export in src/auth/runtime.ts):
```ts
export type JsonObject = Record<string, any>;
export interface AccountView { id:string; label:string; status:string; sharing:boolean; enabled:boolean; isDefault:boolean; identity?:{name?:string;email?:string}; error?:{code:string;message:string} }
export interface ModelView { id:string; displayName:string }
export interface UpstreamResponse { profileId:string; status:number; headers:Headers; events:AsyncIterable<JsonObject> }
export interface AccountRuntime {
  listAccounts():Promise<AccountView[]>;
  signIn(options?:{profileId?:string;newProfile?:boolean;label?:string;reconsent?:boolean}):Promise<unknown>;
  cancelSignIn():void;
  selectAccount(id:string):Promise<void>;
  setEnabled(id:string,enabled:boolean):Promise<void>;
  disconnect(id:string):Promise<void>;
  listModels():Promise<ModelView[]>;
  requestResponses(options:{body:JsonObject;signal?:AbortSignal}):Promise<UpstreamResponse>;
}
// createAccountRuntime({dataDir,encryption?,openBrowser?,fetch?}) -> AccountRuntime
// AppError(status:number,code:string,message:string,param?:string,requestId?:string)
```
Test seams may add constructor options; do not expose test-only credential provisioning through HTTP. `any` at raw event boundary is deliberate; use concrete narrowed fields internally.

### Task 1: Secure SIWC runtime and project foundation

**Files:** root package/config; vendor/siwc/**; src/shared/errors.ts; src/auth/{runtime,dpapi}.ts plus focused auth helpers; scripts/dpapi.ps1; tests/runtime.test.ts, tests/dpapi.test.ts and OAuth/store regression tests.

**Interfaces:** Produces AccountRuntime above. Provider must support actual OAuth and full event stream, not mock production accounts. Export credential-encryption type for injection; tests can use deterministic test encryption in temporary directories. Atomic versioned nonsecret account preferences keyed by stable profile ID if vendor schema not extended.

- [x] Download upstream pinned commit over HTTPS into ignored .tmp, verify commit via git/API and vendor packages/local with license/notice dependencies; record provenance and package scripts. npm dependencies must install; no guessed registry package @siwc/local.
- [x] Establish test runner then write runtime tests, run and record expected failing output. Assertions include: selecting B while A's generator is in flight retains A; disabling A aborts only A; disabled default cannot start inference; newly added account doesn't steal default; two refresh-needing calls issue one refresh; malformed encrypted store is preserved.
```ts
expect((await runtime.listAccounts()).filter(a=>a.isDefault).map(a=>a.id)).toEqual(['a']);
await runtime.selectAccount('b');
expect(inflightA.profileId).toBe('a');
await runtime.setEnabled('a',false);
expect(signalA.aborted).toBe(true);
expect(signalB.aborted).toBe(false);
```
- [x] Reuse existing SDK lifecycle; add explicit-profile request/model/disconnect paths, per-profile cancellation, safe view output, enabled/default rules. Keep rotation persistence and identity verification; add profile-safe sign-in transactions. Only first ready profile auto-selects. Parallel OAuth attempts return connection_busy.
- [x] Replace text-only request restriction with full typed upstream request and AsyncIterable event exposure, no retries, redirect:error, scrub inherited org/project/auth/log settings. Cleanup requests on generator completion/error/cancel; timeout covers body (default 180s configurable by runtime constructor).
- [x] Implement Windows DPAPI provider with fixed helper stdin/stdout binary/base64 protocol, windowsHide:true, no secret arguments. Fail closed elsewhere except explicitly injected test providers. Add real DPAPI roundtrip/tampering test on Windows.
- [x] Preserve/import meaningful official OAuth tests and add callback/nonce/identity and refresh-checkpoint regressions for changed behavior. Run focused tests, then typecheck/full current suite. Commit only task files and write evidence report.

### Task 2: Protocol normalization and complete streaming adapters

**Files:** src/protocol/{normalize,chat,events,sse}.ts as needed; tests/protocol.test.ts, tests/sse.test.ts with small fixtures.

**Interfaces:** Consumes AppError and JsonObject. Exports `normalizeRequest(input:unknown,format:'responses'|'chat'):{body:JsonObject;stream:boolean;ignoredParams:string[];renderOptions:{includeUsage?:boolean}}`, `renderStream(events:AsyncIterable<JsonObject>,format:'responses'|'chat',model:string,options?:{includeUsage?:boolean}):AsyncIterable<string>`, `collectResponse(events:AsyncIterable<JsonObject>,format:'responses'|'chat',model:string):Promise<JsonObject>`. Normalization defaults includeUsage to false; HTTP passes renderOptions only to the downstream renderer, never the upstream body. Event pipeline throws AppError on failed/incomplete/interrupted streams. Preserve final native response object and nontext output. HTTP layer owns client abort/backpressure.

- [x] Write failing tests for messages/system conversion, text/image/file input, function/custom calls, tool results and namespaces, structured output/reasoning, unsupported features, removed params, native passthrough, interleaved tools, refusals, usage and terminal failures; run them before implementation.
```ts
const result=normalizeRequest({model:'test',messages:[{role:'system',content:'rules'},{role:'user',content:'hi'}],temperature:0.5,max_tokens:20},'chat');
expect(result.body).toMatchObject({store:false,stream:true});
expect(result.ignoredParams).toEqual(expect.arrayContaining(['temperature','max_tokens']));
await expect(collectResponse(eventsWithoutCompleted,'responses','test')).rejects.toMatchObject({code:'stream_interrupted'});
```
- [x] Validate model/input/body; default downstream stream=false. Normalize input string to message array and system to developer. Reject persistent state and unsupported tool/media features; remove only explicit documented ordinary unsupported fields. Reject n>1/stop/logprobs and other semantics not implemented rather than falsely honor them. Do not remove unsupported feature settings silently.
- [x] Support flat function/custom tools by deterministic namespace conversion with reversible call name/namespace mapping. Existing native namespaces/additional_tools retained. Map tool_choice and roundtrip tool outputs consistently. Standard Chat formats use corresponding Responses inputs; web search and advanced native forms available through Responses. Preserve reasoning encrypted items passed back by downstream; do not invent reasoning text.
- [x] Stream text/tool/refusal/usage events to Chat chunks with stable call IDs/indexes, never mix item.id with call_id. Native Responses events preserved. Nonstream Chat outputs content/tool_calls/finish_reason/usage; no loss of complete-only function arguments. On failed/incomplete events throw, never emit normal success terminator. Include [DONE] only for completed Chat streams.
- [x] SSE framing/UTF8 splitting tests must cover actual transport parser used by runtime or a tested streaming decoder. Include terminal failure after deltas, premature EOF, mixed tool/text. Inspect official openai-node and CLIProxyAPI upstream examples only as references. Run focused tests/typecheck/current suite and commit; report RED/GREEN evidence.

### Task 3: Local HTTP service, password/key security and dashboard

**Files:** src/server/{app,main,security,store,activity,routes,streaming}.ts plus focused route files; scripts/setup.ts; web/{index.html,src/**,vite.config.ts}; tests/server.test.ts, tests/security.test.ts; .env.example.

**Interfaces:** Consumes AccountRuntime and protocol contracts. `createApp({runtime,dataDir,webDir?,...testOptions})` returns FastifyInstance. Production creates DPAPI runtime, binds 127.0.0.1:8317 (PORT override); Host accepts only localhost/127.0.0.1 and actual port. Data directory defaults project data/ with MAPLEPROXY_DATA_DIR override. No credential options accepted from HTTP.

Admin API: GET /api/admin/session -> {configured,authenticated,csrfToken?}; POST /api/admin/login {password}; POST /api/admin/logout; GET /api/admin/accounts -> {accounts}; POST /api/admin/sign-in {profileId?,newProfile?,label?,reconsent?} -> 202 {id,status}; GET /api/admin/sign-in/:id -> safe job status; DELETE /api/admin/sign-in/:id cancels; POST /api/admin/accounts/:id/default; PATCH /api/admin/accounts/:id {enabled}; POST /api/admin/accounts/:id/disconnect; GET /api/admin/models -> {models}; GET /api/admin/keys -> {keys}; POST /api/admin/keys {name} -> {key,secret}; DELETE /api/admin/keys/:id; GET /api/admin/requests -> {requests}. State-changing admin calls except login require X-CSRF-Token plus exact Origin. OAuth callback is SDK-owned loopback listener with its own state validation. Sign-in jobs bounded and no token fields returned.

- [x] Write failing HTTP tests (Fastify inject + local HTTP where streaming matters) proving password/session setup, API key rejection/acceptance/revocation, CSRF/Origin/Host checks, admin cannot authorize inference via cookie, API key cannot authorize management, request logging excludes content. Run and record RED.
```ts
expect((await app.inject({method:'GET',url:'/v1/models'})).statusCode).toBe(401);
expect((await app.inject({method:'POST',url:'/api/admin/keys',headers:{cookie:sessionCookie},payload:{name:'test'}})).statusCode).toBe(403);
```
- [x] Implement atomic versioned JSON with password scrypt (random salt), constant-time digests, show-once random API keys. Opaque session cookie HttpOnly/SameSite=Strict/Path=/, 12h lifetime, no browser localStorage secrets. Per-origin/IP login rate limiting with bounded storage. CLI prompts hidden password or accepts --password-stdin; supports deliberate password reset which invalidates sessions. No HTTP initial password setup. Config file cannot expose plaintext API keys.
- [x] Implement inference routes, request-start account snapshot, safe error envelope with code/param/request ID, normalized models list, ignored header, SSE backpressure (await drain) and abort on client disconnect. Body limit 32MiB with documented inline files bound. Propagate upstream request IDs without credentials. No inference automatic retries.
- [x] Recent log 200 metadata-only entries: request id, profile ID, model, format, time/duration, result/code, ignored fields. Avoid untrusted error strings/body contents in logs; unexpected server failures return generic error. No fake quota cards or fake production accounts.
- [x] Build polished simple Chinese dashboard with responsive layout: password login, accounts with badges/actions, OAuth pending/cancel/retry status, model list, separate access keys/copy examples/show-once secret, activity filtering/display, clear ignored-parameter explanation and no quota estimate. Buttons call actual backend; loading/error/empty states all covered. Official Continue with ChatGPT text and usage link present.
- [x] Use frontend integration tests for critical login/key/account flows where useful; static style polish checked visually later. Vite dev proxy keeps /api and /v1 same-origin. Build serves web/dist, unknown /api or /v1 returns JSON 404 not index.html. Run full suite/typecheck/build, commit and report.

### Task 4: Integration verification, browser smoke and documentation

**Files:** README.md, docs/compatibility.md, tests/integration.test.ts, scripts/smoke.ts or equivalent smoke harness, necessary focused fixes to existing files.

**Interfaces:** Consumes built server, runtime injection seam and browser UI. Mock upstream/credential fixtures strictly test-only, never production flags or URLs allowing arbitrary credential forwarding.

- [x] Add integration tests for real socket SSE cancellation/backpressure and fragmented upstream events using a local server. Exercise official OpenAI SDK against MapleProxy in tests for both routes if installed SDK supports custom base URL. Assert complete tool roundtrip with multi-turn history; verify no normal success after stream failure. Execution note: existing behavior first ran GREEN, so the originally planned integration RED was not observed; the browser-fetch regression has separate RED/GREEN evidence.
```ts
expect((await client.models.list()).data[0].id).toBe('test-model');
const result=await client.chat.completions.create({model:'test-model',messages:[{role:'user',content:'hello'}]});
expect(result.choices[0].message.content).toBe('hello');
```
- [x] Run clean build/typecheck/full tests once integration changes pass. Launch test-only isolated demo server for browser checks with a mock AccountRuntime and temporary data, never real account tokens. Verify login, account default/disable, show-once key, activity, layout desktop and narrow width using available browser tooling. Remove demo listener after checks; leave normal application ready for user startup.
- [x] README in Chinese: prerequisites, npm ci/build/setup/start, http://127.0.0.1:8317, data/key/password recovery, native Windows credential restriction, local scope, supported model discovery, exact launch and both SDK/curl examples, authorized real OAuth smoke steps, limitations and no quota display. Document no real OpenAI account tested if none supplied by user.
- [x] Compatibility matrix covers filtering/ignored header, all supported request/output types, semantic rejections, SSE errors, timeout/body limits, local tool ownership, absent API routes and HTTP-only context rules. Cite official docs and upstream commit/license, explain DevKit modifications and no private backend dependency.
- [x] Commit integration/docs and report test commands/results and remaining live-OAuth limitation. Integration tests first ran GREEN against existing behavior; actual new RED/GREEN evidence is the browser default-fetch receiver regression. See docs/verification.md for attribution and browser limits.
- [x] Final full-branch read-only review, sole consolidated fix wave and scoped re-review completed: all six original findings addressed, no new Critical/Important issue. Controller accepted conditional bounded cleanup Minor N1 with rationale in docs/verification.md. Working tree committed locally; no push/PR.

## Review and progress

One implementer at a time with fresh task-scoped reviewer. Record commits, evidence and decisions under .superpowers/sdd/2026-10-13-mapleproxy/. User already approved this design and execution: no further design or task-by-task approval prompts needed. Required skill files not installed (using-git-worktrees, finishing-a-development-branch) are not blockers: equivalent native git isolation/verification used; no claimed invocation of missing skills.
