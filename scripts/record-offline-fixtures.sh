#!/usr/bin/env bash
# Records the OFFLINE FIXTURE evidence in fixtures/offline/ by running the
# human-written reference script (sandbox-kit/reference-inspect.mjs) with a
# local Chromium against a locally running Teger Scout server.
# This is development tooling only; it does not use CreateOS or a model.
set -euo pipefail
BASE="${BASE:-http://localhost:8099}"
CHROME_PATH="${CHROME_PATH:?set CHROME_PATH to a local Chrome/Chromium}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
sudo_ln() { mkdir -p /opt/teger && ln -sf "$ROOT/sandbox-kit/scout-kit.mjs" /opt/teger/scout-kit.mjs; }
sudo_ln
declare -A FX=([info]=/fixtures/info [login]=/fixtures/login [redirect]=/fixtures/redirect/start [delayed]=/fixtures/delayed [injection]=/fixtures/injection [blocked]=/fixtures/blocked-redirect)
for key in "${!FX[@]}"; do
  url="$BASE${FX[$key]}"
  cat > "$WORK/task.json" <<JSON
{"url":"$url","allowedHosts":["$(echo "$BASE" | sed -E 's#https?://([^:/]+).*#\1#')"],"resolverRules":"","limits":{"navigationTimeoutMs":10000},"viewport":{"width":1280,"height":800},"outDir":"$WORK/out-$key"}
JSON
  TEGER_TASK_PATH="$WORK/task.json" CHROME_PATH="$CHROME_PATH" timeout 60 node "$ROOT/sandbox-kit/reference-inspect.mjs" >/dev/null
  node -e '
    const fs = require("fs");
    const [key, url, out, dest] = process.argv.slice(1);
    const result = JSON.parse(fs.readFileSync(out + "/result.json", "utf8"));
    const blocked = result.blockedRequests.filter(b => b.isDocument).map(b => ({ url: b.url, reason: "Blocked destination: non-public IPv4 range (cloud metadata / link-local)" }));
    fs.writeFileSync(dest + "/" + key + ".json", JSON.stringify({ note: "OFFLINE FIXTURE: recorded locally with the human-written reference script and local Chromium. Not a CreateOS run, not model-generated.", requestedUrl: url, blockedDestinations: blocked, result }, null, 2));
    fs.copyFileSync(out + "/screenshot.png", dest + "/" + key + ".png");
  ' "$key" "$url" "$WORK/out-$key" "$ROOT/fixtures/offline"
  echo "recorded $key"
done
rm -rf "$WORK"
