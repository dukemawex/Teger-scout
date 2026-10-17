# Repair demonstration (deliberately seeded defect)

The **Repair demonstration** checkbox on the home page starts a live scan whose *first* attempt runs a seeded draft, `sandbox-kit/seeded-draft.mjs`, instead of a model-written script. It is labelled everywhere it appears ("seeded draft (deliberate defect)") and must never be presented as a naturally occurring incident.

## The defect

The seeded draft assumes the login form exists as soon as the page loads and has `id="login"`:

```js
const form = await page.evaluate(() => {
  const f = document.querySelector("form#login");
  return { action: f.action, method: f.method };
});
```

On `/fixtures/delayed`, the form is inserted after three seconds inside a custom element's open shadow root and has no `id`. `querySelector` returns `null`, reading `.action` throws, and the script exits non-zero before it captures a screenshot.

Expected real stderr (from CreateOS):

```
Error: page.evaluate failed: TypeError: Cannot read properties of null (reading 'action')
```

## What the agent must do

The controller sends the eve agent the seeded script, the exit status, the failed acceptance checks (`script exited with status 1`, `result.json missing`, `screenshot check: screenshot file missing`) and the stderr excerpt (fenced as untrusted). The agent has to diagnose the cause and return a repaired script, typically: wait for content, search shadow roots, guard against `null`, and capture the screenshot before extraction. The controller then runs the repair in the same sandbox and verifies it with the same trusted checks.

The demonstration is honest about what is seeded (attempt 1) and what is real: the CreateOS execution, the error, the model's repair, the second execution, the screenshot and the report.

## Running it

1. Open the deployed app.
2. Click **Use for live scan** on "Slow page with unusual markup" (fills `/fixtures/delayed` on the deployment's public URL).
3. Tick **Repair demonstration** and press **Inspect link**.
4. Open **Technical evidence and execution history** to show attempt 1 (seeded, failed, stderr) and attempt 2 (agent-written, passed).
