# Provisioning, deployment and cleanup

Everything below was actually run for the hackathon deployment on 17 October 2026. Secret values are never shown; only variable names.

## 1. Stripe Projects (provisioning and tracking)

```bash
npm install -g @stripe/cli            # stripe 1.54.0
stripe plugin install projects        # projects plugin 0.50.0
stripe login                          # browser device approval by the account owner
stripe projects init teger-scout      # → project_61Vb1taJI8Jto4mzc16Rvh1rH1SQc6d8MlLhIXVs8Tyq
stripe projects add createos/free     --testmode=false --accept-tos --yes   # CreateOS plan: Free ($0)
stripe projects add createos/project  --testmode=false --accept-tos --yes   # CreateOS project credentials
stripe projects add openrouter/free   --testmode=false --accept-tos --yes   # OpenRouter plan: Free ($0)
stripe projects add openrouter/api    --testmode=false --accept-tos --yes   # OpenRouter API key
stripe projects status
```

Notes from the run:
- `init` first required the account owner to finish Stripe Projects onboarding in the dashboard, and live-mode context. The account is `acct_1QmJ4VJQDWbpVXUN`.
- `createos/project` required a plan first (`PLAN_REQUIRED`); the **free** plan was chosen. No paid services were added.

Credentials written to the git-ignored `.env` (names only):

| Resource | Variables |
| --- | --- |
| createos-plan | `CREATEOS_PLAN_API_KEY`, `CREATEOS_PLAN_API_URL`, `CREATEOS_PLAN_DASHBOARD_URL`, `CREATEOS_PLAN_CREDENTIALS` |
| createos-project | `CREATEOS_PROJECT_API_KEY`, `CREATEOS_PROJECT_API_URL`, `CREATEOS_PROJECT_DASHBOARD_URL`, `CREATEOS_PROJECT_CREDENTIALS` |
| openrouter-api | `OPENROUTER_API_API_KEY`, `OPENROUTER_API_TYPE` |
| openrouter-plan | `OPENROUTER_PLAN_API_KEY`, `OPENROUTER_PLAN_TYPE` |

**Deployment vs Sandbox credentials.** Stripe Projects issues CreateOS *platform* keys (`api-createos.nodeops.network`). They were not assumed to work for the Sandbox API: `CREATEOS_PROJECT_API_KEY` was tested against `GET https://api-eu.sb.createos.sh/v1/whoami` and returned 200, so the app uses it as `CREATEOS_SANDBOX_API_KEY` (falling back to the Stripe variable name when the explicit one is unset). The CreateOS CLI uses the same key for deployment.

Files in the public repository: `.projects/state.json` and `.projects/state.local.json` (identifiers only, as Stripe's docs recommend). Never committed: `.env`, `.projects/vault/`, `.projects/cache/`, `.claude/settings.json` (a local permission grant written by the tooling).

## 2. Sandbox account checks (EU region)

Verified with `scripts/createos-probe.ts` and the live test (see `docs/evidence/`):
- `whoami` OK at `https://api-eu.sb.createos.sh` (organizer-supplied region; no silent fallback to `api.sb.createos.sh`).
- Shapes include `s-1vcpu-1gb` (largest on the Free plan). Images: `alpine:3.20`, `debian:13`, `desktop:1`, `devbox:1`, `ubuntu:26.04`.
- `desktop:1` provides Ubuntu 24.04.4, Node v22.23.2 and Google Chrome 152, so the headless-browser approach needs no package installs and egress can be locked before anything runs.
- Free plan limits: 1 concurrent sandbox, 10 creates per rolling 24 h. The app enforces concurrency 1 and a daily cap below that.

## 3. CreateOS deployment

The CreateOS CLI was built from source (`github.com/NodeOps-app/createos-cli`, Go 1.26.3) because the release download is not reachable from the build environment. It reads `CREATEOS_PROJECT_API_KEY` from `.env`.

```bash
createos projects add --name "Teger Scout" --unique-name teger-scout --type upload --runtime dockerfile --port 8080
createos environments create --name production --unique-name production
createos env set --environment <env-id> KEY=value ...     # names listed below; values from .env / generated
createos deploy --project 20ca9287-faf8-4877-b1bc-9085320a0a0b
createos deployments promote --deployment <deployment-id> --environment <env-id>
```

- Production URL: **https://production-teger-scout.tyzo.nodeops.app**
- The container (`Dockerfile`) builds the web UI and the eve agent, then `scripts/start.mjs` runs the eve agent on `127.0.0.1:3101` (random per-boot Basic-auth secret) and the API on `:8080`. This is a long-running single instance, so a scan can run for its whole deadline in-process. Nothing is left running after an HTTP request returns.
- Runtime variables set on the environment (names only): `CREATEOS_SANDBOX_API_KEY`, `CREATEOS_SANDBOX_BASE_URL`, `TEGER_MODEL_PROVIDER`, `TEGER_MODEL_ID`, `TEGER_MODEL_FALLBACKS`, `TEGER_MODEL_API_KEY`, `TEGER_SANDBOX_ROOTFS`, `TEGER_SANDBOX_SHAPE`, `TEGER_SESSION_SECRET`, `TEGER_PUBLIC_URL`, `TEGER_SCAN_DEADLINE_MS`, `TEGER_DAILY_LIVE_SCANS`, `TEGER_SESSION_HOURLY_SCANS`, `NODE_ENV`.
- Warning: `createos environments list -o json` prints environment variable **values**. Filter its output or avoid it in shared logs.

### Persistence
The SQLite database lives on the container disk. It survives page refreshes and SSE reconnects, but not a redeploy or container replacement. Recorded demos in `recorded/` are re-imported at boot. A provisioned store (for example Postgres) would be the next step.

## 4. Vercel (frontend) in front of the CreateOS backend

Scans run for minutes (free models can take 10+), which does not fit request-scoped serverless functions, so the API, controller, eve agent and SQLite stay on the long-running CreateOS service. Vercel serves the static UI and proxies the API on the same origin, so session cookies and the CSRF header work unchanged.

`vercel.json` (no environment variables needed on Vercel):
- `buildCommand: npm run build:web`, `outputDirectory: dist/web`, `framework: null` (prevents auto-detection of the eve package as an app)
- rewrites: `/api/*` and `/fixtures/*` → `https://production-teger-scout.tyzo.nodeops.app/...`; everything else → `index.html`
- the same CSP and security headers as the backend
- the UI falls back to polling `/api/scans/:id/events` every 4 s in case the proxy buffers server-sent events

Verified locally with `vercel build` on a clean clone (status ok; routes as above).

To deploy: Vercel → Add New Project → import `dukemawex/Teger-scout` → keep the settings from `vercel.json` → Deploy. Vercel builds production from the repository's **production branch** (default `main`). Either merge `claude/teger-scout-hackathon-o3923q` into `main`, or set Project Settings → Git → Production Branch to that branch.

## 5. Model keys

`agent/agent.ts` selects the model at runtime (`TEGER_MODEL_PROVIDER=auto` on the deployment):

| Variable (set on the CreateOS environment, not on Vercel) | Effect |
| --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio key. When present, Gemini (`TEGER_GEMINI_MODEL_ID`, default `gemini-flash-latest`) becomes the primary model. |
| `TEGER_MODEL_API_KEY` | Your own OpenRouter key. Overrides the Stripe-provisioned `OPENROUTER_API_API_KEY`. Used for the free OpenRouter models, as the fallback behind Gemini. |
| `TEGER_OPENROUTER_MODEL_ID`, `TEGER_MODEL_FALLBACKS` | Free OpenRouter model and server-side fallback list (max 3 models in total). |

If the primary model's request fails (rate limit, outage, bad key), the same turn is retried on the fallback (`agent/lib/fallback-model.ts`). After adding or changing a key, redeploy (or promote a new deployment) so the container picks it up.

## 6. Cleanup

Scan sandboxes are destroyed by the controller on success, failure, timeout and cancellation; anything left after a crash is destroyed at the next boot (`recoverOrphans`). To check manually:

```bash
createos sandbox list            # or: node --env-file=.env --import tsx scripts/createos-probe.ts
```

To tear down the whole hackathon stack:

```bash
createos projects delete --project 20ca9287-faf8-4877-b1bc-9085320a0a0b
stripe projects remove openrouter-api --yes
stripe projects remove openrouter-plan --yes
stripe projects remove createos-project --yes
stripe projects remove createos-plan --yes
rm .env .env.access; rm -rf .projects/vault
```
