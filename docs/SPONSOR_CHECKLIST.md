# Sponsor integration checklist

Each claim links to the code that implements it and to evidence from actual execution. "Evidence" entries were observed during the hackathon build on 17 October 2026; see also `docs/STATUS.md`.

## CreateOS

| Claim | Code | Evidence |
| --- | --- | --- |
| Real sandbox creation via the official SDK (`@nodeops-createos/sandbox` 0.8.2) in the organizer's EU region | `server/sandbox/createos.ts` (`InspectionSandbox.create`), `server/config.ts` (`CREATEOS_SANDBOX_BASE_URL`, default `https://api-eu.sb.createos.sh`) | `docs/evidence/2026-10-17-live-integration-test.log`: sandbox `sb-01m55rg1hgzrem4zt2rjf6aeja` at `https://api-eu.sb.createos.sh` |
| Image and shape chosen after checking entitlements | `scripts/createos-probe.ts` | `listShapes`/`listRootfs` on the Free plan: `desktop:1` (Ubuntu 24.04.4, Node v22.23.2, Google Chrome 152) on `s-1vcpu-1gb`, the largest Free shape |
| Explicit, non-empty egress applied **at creation**, before any generated code | `InspectionSandbox.create` (`egress` in the create request), `server/policy/egress.ts` (`assertRestrictive`) | Live log: `egress read-back {"ok":true,"effective":["104.20.23.154:443",…]}` |
| Effective policy read back and compared | `verifyEgress` → `getEgress` + `verifyEffectivePolicy` | Same log line; production scans show "Egress policy read back from CreateOS" in the timeline |
| Direct outbound bypass is actually blocked | `probeBypass` (raw TCP via `/dev/tcp` to non-allowlisted IPs) | Live log: `bypass probe {"blocked":true,"details":[{"target":"1.1.1.1:443","reachable":false},{"target":"8.8.8.8:53","reachable":false}]}` |
| Empty / null / `*` never treated as block-all | `assertRestrictive`, `verifyEffectivePolicy` | `tests/egress.test.ts` |
| Egress widened only by trusted code after deterministic validation of redirect hosts | `server/scan/controller.ts` (redirect re-authorisation → `replaceEgress` → `verifyEgress`) | `tests/controller.test.ts` ("revalidates redirect destinations…", "refuses redirects to private destinations…") |
| Command execution with explicit limits | `runScript` (`timeout -k 3 <sec> node /opt/teger/inspect.mjs`), per-request timeout, overall deadline | Production scan `scn_6d10440bd2eb425397bb8b12f7193e99`: 3 attempts (3.8 s, 1.9 s, 1.7 s) |
| Files API for the trusted kit, task, script and artifacts | `prepare`, `writeTask`, `runScript`, `download` | Screenshot and `result.json` downloaded and validated in every live run |
| Browser-based screenshot capture | `sandbox-kit/scout-kit.mjs` (`Page.captureScreenshot`) | `docs/evidence/2026-10-17-live-integration-example-com.png`; production report screenshots |
| Lifecycle cleanup on success, error, timeout, cancellation | `ScanController.run` `finally` → `destroy()` + ledger | Live log `destroyed sb-…`; local live scan that hit the platform's auto-pause still ended with "Sandbox destroyed"; `tests/controller.test.ts` (deadline, cancel) |
| Orphan recovery after controller restart | `recoverOrphans` (startup) | `tests/controller.test.ts` |
| Pause handling | `ensureRunning` (resume if paused), auto-pause set above the deadline as a safety net only | Found live: a 7.7-minute free-model turn let the VM auto-pause at 300 s; fixed and documented in `docs/STATUS.md` |
| Working deployed application on CreateOS | `Dockerfile`, `scripts/start.mjs` | https://production-teger-scout.tyzo.nodeops.app (project `20ca9287-faf8-4877-b1bc-9085320a0a0b`) |

Not implemented, so no buttons for them: live desktop observation, sandbox forking (the Free plan allows 1 concurrent sandbox, so a fork would need a second slot), and a CreateOS live URL for a report viewer.

## Stripe Projects

| Claim | Code / file | Evidence |
| --- | --- | --- |
| Project initialised | `.projects/state.json`, `.projects/state.local.json` | `project_61Vb1taJI8Jto4mzc16Rvh1rH1SQc6d8MlLhIXVs8Tyq` on `acct_1QmJ4VJQDWbpVXUN` |
| CreateOS provisioned (Free plan + project credentials) | `docs/DEPLOYMENT.md` | `stripe projects status`: `createos-plan` free, `createos-project` free |
| Model access provisioned (OpenRouter Free plan + API key) | `agent/agent.ts` reads `OPENROUTER_API_API_KEY` | `stripe projects status`: `openrouter-plan` free, `openrouter-api` free |
| Credentials verified, not assumed (platform key vs Sandbox API) | `server/config.ts` fallback | `whoami` 200 on `https://api-eu.sb.createos.sh` with the Stripe-provisioned key |
| Credential rotation | `stripe projects rotate openrouter-api`, `stripe projects rotate createos-project` | Rotated after values appeared in a CLI listing; new keys verified (CreateOS `whoami` 200, OpenRouter `/key` 200) |
| Share link | n/a | https://projects.dev/s#v1:createos~project,OpenRouter~api |

## eve (agent orchestration)

| Claim | Code | Evidence |
| --- | --- | --- |
| eve agent with configurable model, no tools | `agent/agent.ts` (`defaultTools: false`), `agent/instructions.md` | `/eve/v1/info`: `tools: {static: [], dynamic: []}`, model `teger-model/poolside/laguna-s-2.1:free` |
| Loopback-only, authenticated control plane | `agent/channels/eve.ts` (`httpBasic`), `scripts/start.mjs` (per-boot secret) | `/eve/v1/info` without credentials → 401 |
| Session-based write and repair turns | `server/agent/author.ts` (eve `Client`, sessions) | Production repair demo: attempts 2 and 3 written by the agent in the same eve session |
