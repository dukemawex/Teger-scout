# Implementation status (17 October 2026)

Legend: **Live** = runs for real against CreateOS and a real model in the deployed app. **Fixture** = offline, labelled, no sandbox, no model. **Incomplete** = partially done or known gaps. **Blocked** = needs an account action or a plan change.

## Live

| Feature | Evidence |
| --- | --- |
| Deployed app on CreateOS | https://production-teger-scout.tyzo.nodeops.app (`/api/health` 200; `/api/status` reports live execution, EU sandbox region, no access code (removed at the owner's request)) |
| CreateOS sandbox per scan (EU region, `desktop:1`, `s-1vcpu-1gb`) | Sandboxes `sb-01m55rg1hgzrem4zt2rjf6aeja`, `sb-01m55txjrh9731bwgpxhetrf01`, `sb-01m55vk6qwvf2b2be2dnat7eyk`, `sb-01m55vxtvaj793bp70g3y0076j`, `sb-01m55vzrn7jhz34tjexkzwe5tg`, and those listed under "Live runs" below. All were destroyed at the end of their scans. |
| Egress applied at creation, read back, bypass probe | `docs/evidence/2026-10-17-live-integration-test.log`, and the "Network policy" section of every live report |
| Real model writes the script (eve → OpenRouter free models provisioned via Stripe Projects) | Production scan `scn_5e855879fb38433abda0feffc29b67c7` (`recorded/live-fake-bank-login.json`): agent-written script passed on attempt 1 |
| Real failure → model repair → success | Production scan `scn_6d10440bd2eb425397bb8b12f7193e99` (browser e2e): seeded draft failed (exit 1) → agent repair failed acceptance checks despite exit 0 → second agent repair passed. Production scan `scn_477a985d074d4b2da1589a152f9d0d7f`: seeded draft failed with `TypeError: Cannot read properties of null (reading 'action')`; the agent's repair passed in 5.7 s (`docs/evidence/2026-10-17-prefix-repair-demo-false-negative.json`) |
| Screenshot captured inside the sandbox and served from controlled storage | Every live report above; artifacts served with `CSP: sandbox`, owner-only |
| Redirect revalidation, blocked destinations | Unit/integration tests (`tests/controller.test.ts`); the `/fixtures/blocked-redirect` fixture |
| Cleanup on success, failure, timeout | A local live scan hit the platform's auto-pause during a 7.7-minute model turn and still ended with "Sandbox destroyed" |
| Access control and rate limits for billable scans | `tests/app.test.ts`. Production has no access code (owner's choice); live scans are capped per browser per hour, per deployment per day, and to one at a time. The CreateOS Free plan also caps creates at 10 per 24 h |
| Refresh/reconnect | SSE with `Last-Event-ID` replay plus stored history (`tests/app.test.ts`) |

## Live runs on production (fresh browser or API sessions)

| Scan | Fixture | Attempts | Verdict | Notes |
| --- | --- | --- | --- | --- |
| `scn_6d10440bd2eb425397bb8b12f7193e99` | `/fixtures/delayed` (repair demo) | seeded ✗ → agent ✗ (exit 0, failed checks) → agent ✓ | Suspicious | Browser e2e. Showed two evidence-quality bugs (screenshot before late form; unverified AI-directed text), fixed afterwards |
| `scn_477a985d074d4b2da1589a152f9d0d7f` | `/fixtures/delayed` (repair demo) | seeded ✗ → agent ✓ | No obvious warning signs (**false negative**) | Model's extraction missed the shadow-root form. Fixed by making the verdict rest on trusted kit evidence. Kept as evidence |
| `scn_5e855879fb38433abda0feffc29b67c7` | `/fixtures/login` | agent ✓ | High risk | Recorded demo `rec_live-fake-bank-login` (sandbox `sb-01m55vzrn7jhz34tjexkzwe5tg`) |
| `scn_536ff05aea8e4d74a8ff09b9264e6c2e` | `/fixtures/delayed` (repair demo, after the fix) | seeded ✗ (`TypeError … reading 'action'`, 7.2 s) → agent ✓ (5.7 s) | High risk | Recorded demo `rec_repair-demo-delayed` (sandbox `sb-01m55w6m3cpryh1220rkr6e4ab`). Kit evidence added 2 urgency and 2 credential phrases the script missed. Its "claims to be 'Parcel delivery…'" sign predates the generic-heading filter and is kept as recorded |
| `scn_f51714f32b964d5aa8277915ced6c541` | `/fixtures/injection` | agent ✓ (10.5 s) | High risk | Fresh-browser e2e: 64 s end to end, 0 console errors, 0 requests to any origin other than the app. The HIGH sign came from a generic heading ("Account Center") read as a brand; fixed afterwards (now Suspicious + AI-directed text) |

All 8 sandboxes created on 17 October (probe, live integration test, local live scan, five production scans) were verified **destroyed** via the Sandbox API afterwards (`running 0, paused 0`).

## Tests actually run

- `npm run typecheck`, `npm run lint`, `npm test` (79 passed, 1 live test skipped by default), `npm run build:web`. Also run in GitHub Actions on every push to the branch, all green.
- Opt-in live integration test against CreateOS EU (`npm run test:live`): **passed** (`docs/evidence/2026-10-17-live-integration-test.log`).
- Browser automation against the deployed app: `scripts/e2e-live.mjs` (live repair demo, live injection scan) and `scripts/check-recorded.mjs` (recorded runs, desktop and mobile, console errors, off-origin requests, horizontal overflow).

## Configured, awaiting owner keys

- **Gemini (Google AI Studio)**: supported as the primary model (`agent/agent.ts`, `auto` mode) with OpenRouter free models as fallback (`agent/lib/fallback-model.ts`, unit-tested). Not yet exercised live: it activates once `GEMINI_API_KEY` is set on the CreateOS environment.
- **Owner's own OpenRouter key**: `TEGER_MODEL_API_KEY` overrides the Stripe-provisioned key.
- **Vercel frontend**: `vercel.json` verified with `vercel build` on a clean clone. The live Vercel URL will exist once the owner imports the repository in Vercel.

## Fixture

- Offline fixture mode for all six demonstration pages (`fixtures/offline/`), recorded locally with the human-written reference script and local Chromium. Labelled "OFFLINE FIXTURE (NO SANDBOX, NO MODEL)" everywhere.

## Incomplete / limitations

- **Model speed and availability**: the owner chose free OpenRouter models. They are frequently rate-limited upstream (HTTP 429) or slow (one turn took 7.7 minutes). The agent uses OpenRouter's server-side fallback list and a 20-minute scan deadline. A scan can take from about 1 minute to well over 10. Free models also don't support JSON-schema output, so the agent replies in a text contract (an `Explanation:` line plus one fenced script) that trusted code parses and validates.
- **Persistence**: SQLite on the container disk survives refreshes and reconnects but not redeploys. No provisioned database yet.
- **Previews of real sites**: subresources from hosts other than the navigation hosts are blocked by policy, so third-party CSS, fonts and images are missing.
- **IPv6-only sites** are refused in this pilot.
- **Evidence source**: the verdict uses trusted kit evidence (forms across shadow roots, page text patterns). Model-reported text signals are kept only if the kit text contains them. Brand/claimed-identity extraction still comes from the model's script, so it can be noisy.
- Not implemented, so no UI for them: sandbox fork/pause demonstrations, live desktop observation, CreateOS live URL report viewer.
- **License**: `LICENSE.md` is a placeholder; the owner should choose a license.

## Blocked / owner actions

- **Leaderboard submission** (https://projects.dev/leaderboard) and any organizer form must be submitted by the owner. The draft is in `docs/SUBMISSION.md`. **Not submitted.**
- **Default branch**: merged. `main` was fast-forwarded to the hackathon branch at the owner's request, so Vercel can build production from `main`.
- **Free plan limits**: 1 concurrent sandbox and 10 creates per 24 h. The deployment caps live scans per day below that.
