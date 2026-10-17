# Teger Scout: 90-second demo script

**Setup before recording:** deployed app open in a clean browser window; live access code at hand; one recorded repair run available as backup in case the live sandbox quota is exhausted.

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:10 | Home page | "Someone texts you a link that says your bank account is suspended. Opening it on your phone is the risk. Teger Scout opens it for you, somewhere else." |
| 0:10–0:20 | Click **Use for live scan** on *Slow page with unusual markup*, tick **Repair demonstration**, press **Inspect link** | "This is one of our harmless test pages. I'm also turning on the repair demo: the first script is deliberately broken, and it's labelled that way." |
| 0:20–0:35 | Timeline: *Validating URL*, *Preparing isolated browser*; open Activity log | "The link is checked before anything runs. Then a fresh CreateOS sandbox starts with a network allowlist of exactly the validated IP addresses. We read that policy back and prove that a direct connection to anything else fails." |
| 0:35–0:50 | *Running inspection* → attempt 1 fails → *Repairing code* | "The seeded draft crashes: the login form isn't there yet, it appears three seconds later inside a shadow root. The real error goes back to our eve agent as untrusted data. The agent writes a fix." |
| 0:50–1:05 | Attempt 2 passes → verdict and screenshot appear | "The repaired script runs in the same sandbox. Trusted checks verify the result and the screenshot before we show anything. High risk: it claims to be a courier, asks for a card PIN, and sends it to another website." |
| 1:05–1:20 | Expand **Technical evidence**: both script versions, stderr, repair explanation, sandbox ID, egress rules | "Everything is evidence: both code versions with hashes, the error, the agent's explanation, the sandbox ID and the network policy. The sandbox has already been destroyed." |
| 1:20–1:30 | Back to home, point at *Recorded live inspections* and the Stripe Projects badge in README | "CreateOS and the model were provisioned through Stripe Projects. Teger Scout: see where a link leads before you open it." |

Do not describe the seeded defect as a real incident. If the live run fails for an external reason, say so and switch to the recorded run, which is labelled "Recorded evidence from a live run".
