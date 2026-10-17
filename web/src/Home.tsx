import { useState, type FormEvent } from "react";
import { api, type ScanSummary, type Status } from "./api";
import { VerdictPill } from "./ScanView";

const ACCESS_KEY = "teger.accessCode";

function readStored() {
  try {
    return window.localStorage.getItem(ACCESS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Home({ status, recent, demos, onOpen }: { status: Status | null; recent: ScanSummary[]; demos: ScanSummary[]; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [accessCode, setAccessCode] = useState(readStored);
  const [repairDemo, setRepairDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = status?.liveAvailable ?? false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!live) {
      setError("Live inspection is not configured on this deployment. Use an offline fixture or a recorded demo below.");
      return;
    }
    setBusy(true);
    try {
      try {
        window.localStorage.setItem(ACCESS_KEY, accessCode);
      } catch {
        /* storage unavailable; the code is still sent with this request */
      }
      const { id } = await api.startLive(url, accessCode, repairDemo);
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runFixture(key: string) {
    setError(null);
    try {
      const { id } = await api.startFixture(key);
      onOpen(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="home">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">Check a suspicious link without opening it.</h1>
          <p>
            Paste a link from a text, email or chat. Teger Scout visits it for you inside an isolated CreateOS sandbox, where an AI agent writes the inspection code, runs it, fixes it if it breaks,
            and shows you a screenshot with what it found.
          </p>
        </div>
        <form className="inspect-form" onSubmit={submit} aria-describedby="inspect-help">
          <label htmlFor="url" className="sr-only">
            Link to inspect
          </label>
          <div className="url-row">
            <input
              id="url"
              name="url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/your-suspicious-link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <button type="submit" className="primary" disabled={busy || !url.trim()}>
              {busy ? "Starting…" : "Inspect link"}
            </button>
          </div>
          <p id="inspect-help" className="hint">
            Your browser never loads the link. Only http and https links to public websites are inspected.
          </p>
          {live && (
            <div className="options">
              {status?.accessCodeRequired && (
                <label className="field">
                  <span>Live access code</span>
                  <input type="password" autoComplete="off" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Required: live scans create billable sandboxes" />
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={repairDemo} onChange={(e) => setRepairDemo(e.target.checked)} />
                <span>
                  Repair demonstration: start from a <strong>deliberately broken, seeded</strong> script so you can watch the agent diagnose and repair it.
                </span>
              </label>
            </div>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </form>
      </section>

      <section className="explain" aria-labelledby="what-title">
        <h2 id="what-title">What gets inspected</h2>
        <ol className="explain-grid">
          <li>
            <strong>Where it really goes</strong>
            <span>Every redirect hop, checked against the network policy before the browser may follow it.</span>
          </li>
          <li>
            <strong>Who it claims to be</strong>
            <span>Title, logos and branding compared with the real domain.</span>
          </li>
          <li>
            <strong>What it asks for</strong>
            <span>Password and card forms, and where they would send your details.</span>
          </li>
          <li>
            <strong>How it pressures you</strong>
            <span>Urgency language and hidden text aimed at AI tools.</span>
          </li>
        </ol>
      </section>

      <section className="examples" aria-labelledby="examples-title">
        <div className="section-head">
          <h2 id="examples-title">Safe demonstration pages</h2>
          <p>Harmless test pages controlled by this project. Nothing on them collects data.</p>
        </div>
        <ul className="fixture-list">
          {(status?.fixtures ?? []).map((f) => (
            <li key={f.key} className="fixture">
              <div>
                <strong>{f.label}</strong>
                <code>{f.path}</code>
              </div>
              <div className="fixture-actions">
                {live && status?.fixtures && f.url.startsWith("http") && (
                  <button type="button" className="secondary" onClick={() => setUrl(f.url)}>
                    Use for live scan
                  </button>
                )}
                <button type="button" className="ghost" onClick={() => runFixture(f.key)} title="Shows recorded fixture evidence. No sandbox, no model.">
                  Offline fixture
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {demos.length > 0 && (
        <section aria-labelledby="demo-title">
          <div className="section-head">
            <h2 id="demo-title">Recorded live inspections</h2>
            <p>Real CreateOS runs of the demonstration pages, saved as evidence. Read-only.</p>
          </div>
          <ScanList scans={demos} onOpen={onOpen} />
        </section>
      )}

      {recent.length > 0 && (
        <section aria-labelledby="recent-title">
          <h2 id="recent-title">Your recent inspections</h2>
          <ScanList scans={recent} onOpen={onOpen} />
        </section>
      )}
    </div>
  );
}

function ScanList({ scans, onOpen }: { scans: ScanSummary[]; onOpen: (id: string) => void }) {
  return (
    <ul className="scan-list">
      {scans.map((s) => (
        <li key={s.id}>
          <button className="scan-row" onClick={() => onOpen(s.id)}>
            <span className={`mode-tag ${s.mode}`}>{s.mode === "live" ? "Live" : s.mode === "recorded" ? "Recorded" : "Fixture"}</span>
            <span className="scan-url">{s.url}</span>
            {s.verdict ? <VerdictPill verdict={s.verdict} /> : <span className="muted">{s.status}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
