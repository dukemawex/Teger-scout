# Teger Scout architecture and threat model

## Components

```
 Browser (React SPA)                         never loads the inspected site
   │  same-origin JSON + SSE, signed session cookie
   ▼
 Teger Scout API (Hono, Node 24)  ── server/app.ts
   │   • session-scoped scan ownership, access code for live scans, rate limits
   │   • SQLite (node:sqlite) for scans, events, attempts, artifacts, sandbox ledger
   │   • artifacts served from controlled storage with `CSP: sandbox`
   │
   ├─ Trusted policy  ── server/policy/{url,ip,egress}.ts
   │     URL parsing, IP classification, DNS resolution + validation,
   │     least-privilege IP:port egress rules, Chrome resolver pinning
   │
   ├─ Scan controller ── server/scan/controller.ts
   │     bounded write → validate → run → verify → repair loop, deadline,
   │     cancellation, redirect re-authorisation, evidence collection, cleanup
   │
   ├─ Inspection author (eve) ── agent/  +  server/agent/author.ts
   │     separate process on 127.0.0.1:3101, HTTP Basic with a per-boot secret,
   │     `defaultTools: false` → the model has no tools and returns only
   │     {script, explanation} via eve's per-turn outputSchema
   │
   └─ CreateOS sandbox manager ── server/sandbox/createos.ts
         @nodeops-createos/sandbox SDK against CREATEOS_SANDBOX_BASE_URL
         (organizer region: https://api-eu.sb.createos.sh)
                │
                ▼
        CreateOS microVM (one per scan, destroyed afterwards)
          /opt/teger/scout-kit.mjs  trusted helper (uploaded by controller)
          /opt/teger/task.json      authorised URL, hosts, resolver rules
          /opt/teger/inspect.mjs    model-generated script (untrusted)
          headless Chrome → page under inspection
          egress: only validated IP:80/443 rules, enforced on the host
```

Responsibilities are separated as the brief requires:

| Responsibility | Where | Trusted? |
| --- | --- | --- |
| Web interface and authenticated API | `web/`, `server/app.ts` | yes |
| Agent orchestration and model calls | `agent/` (eve), `server/agent/author.ts` | orchestration yes, model output no |
| URL and network policy | `server/policy/*` | yes |
| Sandbox lifecycle | `server/sandbox/createos.ts` | yes |
| Inspection artifacts and report validation | `server/scan/contract.ts`, `server/scan/report.ts` | yes |
| Durable scan status and event history | `server/store/db.ts` | yes |
| Inspection script | runs only in CreateOS | **no** |

## The loop (server/scan/controller.ts)

1. **Validate** the URL (`parseTarget`) and resolve the host (`authorizeHost`). Every resolved address must be public IPv4; one private answer blocks the host.
2. **Create the sandbox with egress already applied** (`egress` in the create request), read the policy back (`getEgress`) and compare it with what was applied, then run a **bypass probe**: raw TCP from the VM to public addresses that are not on the list must fail.
3. **Ask the model** (eve session turn with an output schema) for `inspect.mjs`. In the labelled repair demonstration, attempt 1 is a seeded, deliberately broken draft instead.
4. **Static checks** reject out-of-contract code (no `child_process`, raw sockets, policy references, form submission; must import the kit and call `writeResult`).
5. **Execute** with a fixed command (`timeout -k 3 <limit> node /opt/teger/inspect.mjs`); the model never controls the run configuration.
6. **Collect** stdout, stderr, exit status, `result.json` and `screenshot.png`.
7. **Verify** with trusted checks. Exit code 0 alone is never enough: the result must match the zod contract, refer to the authorised URL, have a final host that was authorised, and the PNG must exist with valid signature, IHDR dimensions (200–4096 px) and size (1 KB–6 MB).
8. **Redirects to new hosts** show up as blocked document requests. The controller validates the new host deterministically; only if it passes are its validated IPs added to egress (`setEgress`, then read back again) and the same script re-run. Refused hosts become "blocked destination" evidence. At most 3 widenings.
9. **Repair**: on failure the model receives the previous script, exit status, failed checks, and stdout/stderr excerpts fenced as `<untrusted>` data, and returns a targeted fix. Default 3 attempts, 5-minute overall deadline (both configurable).
10. **Report**: verdict computed by deterministic rules from validated evidence (`server/scan/report.ts`). Then **always destroy the sandbox** (success, error, timeout, cancellation). A sandbox ledger plus `recoverOrphans()` destroys anything left behind after a controller restart.

Every generated script version, its sha256, the repair explanation, exit status, excerpts and failed checks are stored per attempt and shown in the technical panel.

## Threat model

### Assets
Model and CreateOS credentials; the controller and its database; other users' scan results; the user's device; the CreateOS account's quota and credits.

### Adversaries
- The **inspected page** (malicious HTML/JS, redirects, prompt injection, resource exhaustion).
- **Generated code** (buggy or steered by injected text it saw in repair feedback).
- **Other users** of the deployment (IDOR, quota abuse).

### Controls

| Threat | Control |
| --- | --- |
| SSRF to loopback/private/metadata via URL | `parseTarget`: http/https only, no embedded credentials, ports 80/443 only, blocked internal hostnames; WHATWG URL canonicalises `0x7f.1`, `2130706433`, `0177.0.0.1` before `classifyIp` checks IPv4 and IPv6 ranges (incl. mapped/NAT64/6to4/ULA/link-local). |
| SSRF via DNS (private answers, mixed answers) | `authorizeHost` rejects a host if *any* resolved address is non-public; IPv6-only hosts are refused in this pilot. |
| DNS rebinding at connection time | Egress is expressed as **validated IP:port rules**, not hostnames, and enforced by CreateOS on the host outside the VM. Chrome is started with `--host-resolver-rules="MAP host ip, MAP * ~NOTFOUND"`. Even if code inside the VM resolves a name differently, it can only connect to addresses the controller validated. |
| Redirect to a blocked destination | Browser requests to unauthorised hosts are failed by the kit (`Fetch.failRequest`) *and* unreachable at the network layer. The controller re-validates each new document host before authorising it. |
| Generated code bypassing the kit (raw sockets, curl) | Kit is defence in depth only. The boundary is the CreateOS egress allowlist; the bypass probe verifies it on every scan. |
| "Empty list means block" mistake | `assertRestrictive` refuses `[]`, `null`, `*`, wildcards and CIDRs everywhere egress is set; `verifyEffectivePolicy` rejects an empty effective policy as allow-all. |
| Credential leakage into the sandbox | The VM receives only the kit, the task file and the script. No env vars, keys or tokens are passed to it. The eve agent and model keys live in the controller container. |
| Prompt injection from page content | The model never sees the page before writing the first script (the URL is passed at runtime via `task.url`). Later it sees only fenced excerpts labelled untrusted. It has **no tools**. Verdicts are computed by deterministic code, and AI-directed text is surfaced as a warning sign. |
| Model weakening checks | Acceptance checks, limits, run command, egress and task file are controller-owned; the model only returns script text. |
| Form submission / purchases / downloads | Kit blocks every non-GET/HEAD request and sets `Browser.setDownloadBehavior: deny`; static checks reject `.submit()`; fixture pages disable submission. |
| Resource exhaustion | Script timeout, overall deadline, result size cap (256 KB), screenshot cap (6 MB), max 30 redirect hops recorded, max 3 attempts and 3 host widenings, one sandbox at a time. |
| Cross-user access | Scans belong to an HMAC-signed anonymous session; other sessions get 404 for scans, events and artifacts. Public demo scans are only controlled fixture data. |
| Cost abuse | Live scans require `TEGER_LIVE_ACCESS_CODE`, per-session hourly limit, deployment-wide daily cap, concurrency 1. |
| CSRF | SameSite=Lax cookie plus required `x-teger-client` header on mutating requests. |
| Malicious artifact content | Screenshots are served from controller storage as `image/png` with `nosniff` and `CSP: default-src 'none'; sandbox`. The SPA never embeds the inspected site (no iframe, favicon or remote image). |
| Orphaned sandboxes | Ledger of created sandboxes; `finally` cleanup; startup `recoverOrphans`; 300 s auto-pause only as a safety net. |

### Known limitations
- Subresources from hosts other than the authorised navigation hosts are blocked, so previews of real sites can look unstyled. This is the honest cost of a least-privilege policy.
- Shared hosting/CDN IPs: authorising a CDN IP also permits other sites on that IP. They are public addresses, so this does not create SSRF, but it is broader than a single site.
- The SQLite database lives on the deployment's container disk. It survives refresh and reconnect but not a redeploy. Recorded demos are re-imported from the repository at boot.
- The eve runtime requires a sandbox provider at build time; `just-bash` (an in-process simulated shell) is installed to satisfy it. The agent has no tools, so it cannot use it.
