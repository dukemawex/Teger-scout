# Hackathon submission draft: Teger Scout

**Status: draft prepared, not submitted.** The owner submits it on the Stripe Projects leaderboard (https://projects.dev/leaderboard) and any organizer form.

| Field | Value |
| --- | --- |
| Project name | Teger Scout |
| Team / company | DUKERS LTD (Emmanuel Effiom Duke) |
| Public repository | https://github.com/dukemawex/Teger-scout |
| Working application | https://production-teger-scout.tyzo.nodeops.app |
| Stripe account ID | `acct_1QmJ4VJQDWbpVXUN` |
| Stripe Projects share link | https://projects.dev/s#v1:createos~project,OpenRouter~api |
| Hackathon code | CreateOS-2026 |
| Tagline | See where a link leads before you open it. |

## Short description (≈100 words)

Teger Scout lets anyone check a suspicious link without opening it on their own device. An eve agent writes a browser-inspection script; a trusted controller runs it inside a fresh CreateOS sandbox whose egress is locked to the link's validated IP addresses (read back and bypass-tested before any generated code runs). When the script fails, the agent gets the real error and repairs its code. Verified evidence (a screenshot captured in the sandbox, the redirect chain, login forms and their destinations, claimed identity, and pressure language) becomes a plain-language verdict. Then the sandbox is destroyed.

## The problem

People in small businesses and families receive "your account is suspended", parcel-fee and invoice links every day. Opening them on a phone or office laptop is the risk. Existing URL scanners mostly return a reputation score; they rarely show *what the page actually asks for and where it sends it*, and they cannot adapt when a page renders late or hides its form in unusual markup.

## What we built during the hackathon

- **Agent write → run → repair loop** (`server/scan/controller.ts`): a bounded loop (3 attempts, configurable deadline). The model (an eve agent with *no tools*) only returns script text. The controller validates it statically, runs it with a fixed command in CreateOS, and accepts it only if trusted checks pass: the result contract (zod), and a real PNG with sane dimensions and size. Exit code 0 alone is never enough. On failure the agent receives the script, the failed checks and the stderr (fenced as untrusted) and returns a targeted repair. Every version, hash, explanation and outcome is stored and shown.
- **Meaningful CreateOS usage** (`server/sandbox/createos.ts`): one `desktop:1` sandbox per scan in the organizer's EU region; egress set *at creation* to least-privilege `IP:port` rules (never empty or wildcard, because those mean allow-all on CreateOS), read back with `getEgress`, and proven with a raw-TCP bypass probe; redirect destinations are re-validated and egress widened only by the controller with `setEgress`; headless Google Chrome with DNS pinned to the validated IPs; files API for the trusted kit and artifacts; guaranteed `destroy()` on success, error, timeout and cancellation; orphan recovery on restart; resume if the platform paused the VM. The app itself is deployed on CreateOS.
- **Meaningful Stripe Projects usage**: CreateOS (free plan + project credentials) and OpenRouter (free plan + API key) were provisioned and are tracked through Stripe Projects. The CreateOS key from Stripe Projects was verified against the Sandbox API before use. When credentials were exposed in a log during the build, they were rotated with `stripe projects rotate`.
- **Security boundaries**: SSRF-hardened URL policy (alternate IPv4 encodings, IPv6-mapped/NAT64, metadata, DNS answers), DNS-rebinding-resistant egress, no credentials in the VM, no form submission or downloads, prompt-injection content kept as evidence, session-scoped access to scans and artifacts, rate limits and a one-at-a-time cap for billable scans (an access code is supported but switched off for judging).
- **Investigation workspace UI**: live timeline (SSE with replay), prominent screenshot evidence, redirect chain, warning signs, coverage and limitations, and an expandable technical panel with every script version.
- **Six harmless fixtures** and a clearly labelled **repair demonstration** (seeded defective first draft; the real agent repairs it at runtime).

We do not claim the general idea of previewing links as new. The contribution is the sandboxed, policy-enforced agent loop with evidence.

## Demo evidence

See `docs/STATUS.md` for the exact live runs (sandbox IDs, timings, outcomes) and `docs/evidence/`.
