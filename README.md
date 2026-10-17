# Teger Scout

**See where a link leads before you open it.**

Teger Scout helps individuals and small businesses inspect suspicious links without opening them on their own devices. An AI agent writes inspection code, a trusted controller runs it inside an isolated **CreateOS sandbox** with a locked-down network policy, the agent diagnoses and repairs its own code when it fails, and the user gets an evidence-based report with an automatic screenshot preview.

Built by **DUKERS LTD** (Emmanuel Effiom Duke) for the CreateOS × Stripe Projects hackathon, October 2026. This is a fresh prototype written during the hackathon. It does not reuse code from the Teger AI production application.

> Link previewing and phishing detection are not new ideas. What this project explores is the agent write → run → repair loop inside a policy-enforced CreateOS sandbox, with every step recorded as evidence.

## Links

- **Live app (CreateOS):** https://production-teger-scout.tyzo.nodeops.app. Open to everyone, including live scans. Each live scan creates a sandbox, so scans are limited per browser per hour, per deployment per day, and to one at a time. An optional access code (`TEGER_LIVE_ACCESS_CODE`) can be turned back on.
- **Vercel:** the repository deploys to Vercel as the frontend (`vercel.json`), proxying `/api` to the CreateOS backend. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#4-vercel-frontend-in-front-of-the-createos-backend).
- **Stripe Projects share link:** https://projects.dev/s#v1:createos~project,OpenRouter~api
- Demo script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) · Submission draft: [docs/SUBMISSION.md](docs/SUBMISSION.md) · Sponsor checklist: [docs/SPONSOR_CHECKLIST.md](docs/SPONSOR_CHECKLIST.md)

## Implementation status

See [docs/STATUS.md](docs/STATUS.md) for the exact, evidence-linked status of every feature (live, fixture-based, incomplete, or blocked by credentials or plan limits).

## How it works

```
paste link → validate (trusted) → CreateOS sandbox with IP-allowlist egress → eve agent writes inspect.mjs
          → run in sandbox → trusted acceptance checks → (fail? agent repairs, max 3 attempts)
          → verified screenshot + evidence → deterministic verdict → sandbox destroyed
```

- **Agent**: an [eve](https://www.npmjs.com/package/eve) agent (`agent/`) with no tools (`defaultTools: false`). It returns only a script and a one-line explanation (eve output schema, or a parsed text contract for models without JSON-schema support). Models: Gemini via a Google AI Studio key when configured, with OpenRouter free models (provisioned through Stripe Projects, or your own key) as fallback.
- **Controller** (`server/scan/controller.ts`): owns the loop, limits, acceptance checks, network policy, redirect re-authorisation, and cleanup. The model cannot change any of them.
- **Sandbox** (`server/sandbox/createos.ts`): `@nodeops-createos/sandbox` against `CREATEOS_SANDBOX_BASE_URL` (organizer region `https://api-eu.sb.createos.sh`). Egress is set at creation to validated `IP:80/443` rules, read back, and tested with a bypass probe before any generated code runs.
- **Trusted kit** (`sandbox-kit/scout-kit.mjs`): uploaded into the VM; launches headless Chrome with DNS pinned to validated IPs, blocks unauthorised hosts and every non-GET request, records the redirect chain, captures the screenshot.
- **Report** (`server/scan/report.ts`): verdicts (*High risk*, *Suspicious*, *No obvious warning signs observed*, *Inconclusive*) are computed by deterministic rules from validated evidence. A missing screenshot always yields *Preview unavailable* and a partial or inconclusive result.

Full design and threat model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Execution modes (always labelled in the UI)

| Mode | What runs | Where it is shown |
| --- | --- | --- |
| **Live CreateOS execution** | Real sandbox, real model, real browser | Teal "LIVE" tag |
| **Recorded evidence from a live run** | Saved export of a real live scan of a fixture page (`recorded/`) | Dark "RECORDED" tag |
| **Offline fixture** | No sandbox and no model. Evidence was recorded locally from the fixture pages with the human-written reference script | Amber "OFFLINE FIXTURE" tag |

## Run locally

Requires Node 24 (eve needs ≥ 24).

```bash
npm ci
cp .env.example .env            # fill in what you have; offline fixtures work with nothing
npm run build:web
npx eve build
npx eve start --host 127.0.0.1 --port 3101 &   # needs EVE_INTERNAL_PASSWORD and model key in env
npm start                                       # http://localhost:8080
```

Or run both processes with one launcher (generates a per-boot eve password): `node scripts/start.mjs`.

Without CreateOS and model credentials the app runs in **offline fixture mode**: the UI says so, live scans are refused with a clear message, and the six demonstration pages can be opened as labelled offline fixtures.

## Provisioning with Stripe Projects

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the exact commands that were run, which credentials each step produced, and how to clean up.

## Tests

```bash
npm run typecheck && npm run lint && npm test && npm run build:web
TEGER_LIVE_TEST=1 CREATEOS_SANDBOX_API_KEY=... npm run test:live   # opt-in real CreateOS integration test
```

The suite covers URL validation and SSRF bypasses (alternate IPv4 encodings, IPv6-mapped, NAT64, metadata, DNS answers), CreateOS egress semantics (empty/null/wildcard = allow-all, refused), redirect re-validation, prompt-injection handling, the repair loop, screenshot validation and *Preview unavailable*, cross-session access, CSRF, access codes and rate limits, deadline, cancellation and orphan cleanup, and event replay after reconnect.

## Demonstration pages

Served by the app under `/fixtures/` (harmless, no data collected, `form-action 'none'`):

| Path | Purpose |
| --- | --- |
| `/fixtures/info` | Normal information page |
| `/fixtures/login` | Simulated phishing login for a fictional bank ("NorthPeak Bank") |
| `/fixtures/redirect/start` | 3-hop redirect chain ending at the fake login (query token redacted in views) |
| `/fixtures/delayed` | Form appears after 3 s inside a shadow root (unexpected markup) |
| `/fixtures/injection` | Hidden prompt-injection text aimed at AI scanners |
| `/fixtures/blocked-redirect` | Redirects to `169.254.169.254` (blocked destination) |

The repair demonstration is documented in [docs/REPAIR_DEMO.md](docs/REPAIR_DEMO.md).

## Repository layout

```
agent/            eve agent: agent.ts (model config), instructions.md, channels/eve.ts (Basic auth)
sandbox-kit/      trusted in-VM helper, seeded defective draft, human-written reference script
server/           API, policy, controller, CreateOS manager, store, fixtures, offline mode
web/              React UI
tests/            vitest suites; tests/live is the opt-in real integration test
fixtures/offline/ offline fixture evidence (labelled)
recorded/         exports of real live runs of fixture pages
docs/             architecture, threat model, deployment, demo script, submission, sponsor checklist
```

## License

Not yet chosen by the owner. `LICENSE.md` currently holds a placeholder.
