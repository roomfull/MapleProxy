# Cross-device ChatGPT login implementation plan

Approved by the user on 2026-10-14. Implement in `codex/remote-chatgpt-login`.

**Goal:** Copy an authorization link to another device, authorize there, and paste the complete callback URL into the local MapleProxy dashboard.

**Architecture:** Preserve the SIWC authorization-code/PKCE flow and loopback listener. Manual and HTTP callbacks use one validator and one atomic consumption gate. The dashboard submits callback text to an authenticated management route; the server never fetches pasted URLs.

## Global constraints

- Native Windows, local management only, existing DPAPI credentials; no Redis or data migration.
- Browser mode defaults to existing behavior and expires after 5 minutes. Manual mode never launches a browser and expires after 10 minutes. Deadline covers the whole job, including an automatic retry.
- All callback URL/state/code data remains transient; no callbacks, tokens or verifiers in logs/API errors. Only waiting manual authorization URLs may be returned to authenticated management UI.
- Existing PKCE, nonce, JWKS/issuer/audience/subject verification, dynamic client registration preservation, default account behavior and cancellation reservation remain intact.
- TDD for meaningful behavior changes. Use synthetic accounts/upstreams and temporary directories. No real OAuth or unrelated credentials during automated testing.
- Update DevKit PROVENANCE for vendor edits. Reference implementations: https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/oauth_callback.go and https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/packages/local/src/oauth.ts (inspected during planning).

## Task 1: Authorization core and management API

Implement SDK/runtime/server changes with focused regression tests. Scope: vendor/siwc/src/{types,oauth,index}.ts, src/auth/runtime.ts, src/server/routes.ts (extract a focused sign-in routes module if needed), tests and vendor PROVENANCE. Do not edit frontend or README.

Interfaces: export SignInMode = "browser" | "manual"; SignInRequest has existing profileId?, newProfile?, label?, reconsent? plus mode?. SignInOptions adds onProgress?: (progress: SignInProgress) => void. SignInProgress is {phase:"awaiting_callback", authorizationUrl:string, submitCallback:(callbackUrl:string)=>void} | {phase:"exchanging"}. Runtime signIn accepts these options. SDK emits new waiting event on each retry and exchanging on either accepted callback source. Never serialize submitCallback.

Manual mode skips the configured/default opener. Both modes keep the HTTP listener. Shared validation requires exact callback origin and path and timing-safe state, one state and one code (or a valid OAuth error); reject duplicate code/state/client_id/error, code+error ambiguity, missing or invalid client registration, userinfo, fragments, controls and malformed URL. Trim surrounding whitespace and impose a 16 KiB UTF-8 byte limit. Reject invalid pasted inputs with safe callback errors while keeping the attempt pending. Known error callbacks with correct state terminate authorization. Accept at most once even across HTTP/manual competition; stale closures must reject after close, cancel, consumption or retry. Reuse the original redirect URI and PKCE verifier at token exchange. Retain existing single automatic invalid_grant retry and saved registration.

HTTP public Job shape: {id,status,createdAt,code?,mode,expiresAt,phase,options,authorizationUrl?}. status retains pending/completed/failed/cancelled. phase is preparing/awaiting_callback/exchanging. mode is normalized; options contains original safe request options including normalized mode for retry restoration. expiresAt is ISO string. Only include authorizationUrl while manual, pending, awaiting callback. Public snapshots are explicit projections, not internal object spreading.

POST /api/admin/sign-in accepts mode, defaults browser, returns 202 Job. GET /api/admin/sign-in/:id returns Job. GET /api/admin/sign-in/active returns {job: Job|null}, including a terminal reservation until the original promise settles. POST /api/admin/sign-in/:id/callback accepts exactly {callbackUrl}, requires manual/active/pending/awaiting callback, accepts with 202 Job and continues async exchange. Malformed input 400, unknown job 404, consumed/not ready/terminal/wrong mode 409. All new routes require existing admin session; mutations retain Origin/CSRF; no-store applies. Input maxlength validation must not reuse existing 1024-character text helper. Enforce expiresAt before callback admission in addition to timer. Invalid callback must not consume job. On acceptance and every terminal transition clear URL and function immediately. Ignore late progress events after terminal/deadline and guard against old job callbacks changing a new job. Retain active reservation until promise settles even after cancel/deadline.

Tests: manual mode doesn't open browser; new and saved profiles complete with original PKCE+redirect; malformed/missing/duplicate params and wrong URL/state can be corrected; unknown URL is never fetched; denial; manual replay and HTTP/manual race; stale handles after abort/close/retry; invalid_grant yields fresh URL and original client registration; invalid nonce and account mismatch remain rejected. Management tests cover both deadlines, no reset on retry, authorization/CSRF/Host/Origin, job recovery with original options, 400/404/409, secret projection/cleanup, cancellation before promise settles and delayed events. Record RED/GREEN commands and results.

## Task 2: Dashboard, fixture and documentation

Implement frontend and isolated fixture using Task 1 interfaces; do not change authorization semantics. Add a dedicated SignInProgress component, updated Job/SignInRequest types and typed API helpers. Accounts: preserve Continue with ChatGPT and add separate "复制链接登录"; each existing account gets "复制链接重新授权" with profileId and reconsent true. Retry uses job.options.

Progress UI shows preparing, waiting and exchanging distinctly, 10/5-minute countdown based on expiresAt, read-only selectable authorization URL and copy button, textarea for complete callback URL, submit and cancel. Explain that another device may show the loopback address cannot be reached; copy full address bar URL then submit locally. Never show success until completed. Invalid callback retains editable input for correction, errors stay visible; repeated submission is blocked synchronously. Clipboard failure gives a useful manual selection message. Clear callback on new job, new authorization attempt, exchange, terminal state and logout. When invalid_grant produces new link show "授权链接已更新，请重新复制". Restore active job after authenticated session/bootstrap or relogin via GET /sign-in/active, resume polling, preserve original options, and clear UI sensitive state on logout/session expiry. Handle stale async requests so responses cannot repopulate after logout or overwrite newer jobs/phases.

Extend isolated smoke fixture to generate synthetic manual URL and accept a synthetic callback without real provider traffic, allow demonstration of invalid callback correction/new link/cancellation/success. Ensure secret fixture data never touches production. Tests cover UI states and API callback payloads; use browser fixture for interactions, clipboard fallback, refresh and relogin recovery, link rotation, countdown, desktop and 390px width. Update README and docs/compatibility.md to explain cross-device flow and local-only boundary. Update docs/verification.md with actual automated/browser evidence and explicitly pending user-performed real cross-device OAuth.

## Final acceptance

Run npm test, npm run typecheck, npm run build, node .github/scripts/verify-licenses.mjs, npm run notices:generate and verify no unexpected notice drift. Independently review each task and the whole branch. Preserve existing user work; commit only task changes. No merge/push/release is requested.

## Progress

- [x] Task 1 implemented and reviewed (6307f7d; focused 81/81 and original authorization 4/4 passed).
- [x] Task 2 implemented and reviewed (1efef98; browser fallback evidence f5d08e5; recovery race fix cab261f).
- [x] Full checks, browser verification and whole-branch review (346 project tests; vendor 56 passed/1 platform skip; typecheck/build/license/notices passed; final P2 fixed and independently re-reviewed).
- [ ] User-performed real cross-device OAuth (not part of automated acceptance).
