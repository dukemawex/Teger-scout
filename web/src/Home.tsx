import { useRef, useState, type FormEvent } from "react";
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

const RIBBON = ["Write the code", "Run it sandboxed", "Repair what breaks", "Show the evidence", "Never open it yourself"];

export function Home({ status, recent, demos, onOpen }: { status: Status | null; recent: ScanSummary[]; demos: ScanSummary[]; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [accessCode, setAccessCode] = useState(readStored);
  const [repairDemo, setRepairDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = status?.liveAvailable ?? false;
  // Only a recorded live repair run is shown in the hero card; otherwise a neutral outline.
  const featured = demos.find((d) => d.repairDemo && d.mode === "recorded");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!live) {
      setError("Live inspection is not configured on this deployment. Use an offline fixture or a recorded run below.");
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

  const fillForLive = (u: string) => {
    setUrl(u);
    inputRef.current?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="home">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" aria-hidden="true" /> Sandboxed link recon
          </span>
          <h1 id="hero-title">
            See where it leads. <span className="hl">Before you click.</span>
          </h1>
          <p className="lede">
            Paste a link from a text, email or chat. An AI agent writes the inspection code, runs it inside an isolated CreateOS sandbox, repairs it if it breaks, and brings back a
            screenshot and plain-language evidence.
          </p>

          <form className="inspect-form" onSubmit={submit} aria-describedby="inspect-help">
            <label htmlFor="url" className="sr-only">
              Link to inspect
            </label>
            <div className="url-row">
              <input
                id="url"
                ref={inputRef}
                name="url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://suspicious-link.example/verify"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
              <button type="submit" className="primary" disabled={busy || !url.trim()}>
                {busy ? "Starting…" : "Inspect link"} <span aria-hidden="true">→</span>
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
                    <input type="password" autoComplete="off" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Live scans create billable sandboxes" />
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={repairDemo} onChange={(e) => setRepairDemo(e.target.checked)} />
                  <span>
                    Repair demonstration: start from a <strong>deliberately broken, seeded</strong> script and watch the agent repair it.
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

          <ul className="chips" aria-label="Safeguards">
            <li>CreateOS sandbox</li>
            <li>Egress locked to validated IPs</li>
            <li>Agent-repaired code</li>
            <li>Nothing submitted</li>
          </ul>
        </div>

        <aside className="hero-card-wrap" aria-label={featured ? "Preview of a recorded live inspection" : "How a report looks"}>
          <div className="sticker sticker-top">{featured ? "Agent repaired" : "Read-only visit"}</div>
          <div className="hero-card">
            <div className="window-dots" aria-hidden="true">
              <span />
              <span />
              <span />
              <em>{featured ? "recorded live run" : "inspection report"}</em>
            </div>
            <div className="hero-card-dark">
              <span className="mono-label">{featured ? "Recorded live inspection" : "Inspection report"}</span>
              <strong>{featured ? "Parcel fee page asks for a card PIN" : "Screenshot, redirects, forms, verdict"}</strong>
              <div className="pill-row">
                <span>CreateOS sandbox</span>
                <span>Egress locked</span>
              </div>
            </div>
            <span className="mono-label small">{featured ? "Attempt log" : "Steps"}</span>
            <ul className="mini-log">
              {(featured
                ? [
                    ["1", "Seeded draft", "TypeError · null form", "Failed", "bad"],
                    ["2", "Agent repair", "waits, scans shadow roots", "Passed", "good"],
                    ["✓", "Verdict", "card PIN posted off-site", featured.verdict ?? "", "bad"],
                  ]
                : [
                    ["1", "Validate link", "public addresses only", "Policy", "neutral"],
                    ["2", "Agent writes + runs code", "repairs on failure", "Sandbox", "neutral"],
                    ["3", "Evidence and verdict", "VM destroyed after", "Report", "neutral"],
                  ]
              ).map(([n, title, sub, tag, tone]) => (
                <li key={n + title}>
                  <span className="avatar">{n}</span>
                  <span>
                    {title}
                    <em>{sub}</em>
                  </span>
                  <span className={`tag ${tone}`}>{tag}</span>
                </li>
              ))}
            </ul>
            {featured && (
              <button type="button" className="ghost wide" onClick={() => onOpen(featured.id)}>
                Open this recorded run →
              </button>
            )}
          </div>
          <div className="sticker sticker-bottom">
            <span aria-hidden="true">✓</span> {featured ? "Sandbox destroyed" : "One VM per link"}
          </div>
        </aside>
      </section>

      <div className="ribbon" aria-hidden="true">
        <div className="ribbon-track">
          {[...RIBBON, ...RIBBON, ...RIBBON].map((t, i) => (
            <span key={i}>
              {t} <b>✦</b>
            </span>
          ))}
        </div>
      </div>

      <section className="steps" aria-labelledby="steps-title">
        <div className="steps-head">
          <span className="eyebrow plain">Zero clicks on your side</span>
          <h2 id="steps-title">Your link, someone else's computer.</h2>
        </div>
        <ol className="step-list">
          <li>
            <span className="num">01</span>
            <div>
              <h3>Check the destination</h3>
              <p>The link is parsed and resolved first. Private, internal and cloud-metadata addresses are refused before anything runs.</p>
            </div>
          </li>
          <li>
            <span className="num">02</span>
            <div>
              <h3>Lock the sandbox</h3>
              <p>A fresh CreateOS VM starts with network access to exactly the validated IP addresses. The policy is read back and a bypass attempt must fail.</p>
            </div>
          </li>
          <li>
            <span className="num">03</span>
            <div>
              <h3>Write, run, repair</h3>
              <p>The agent writes the inspection script. If it crashes or fails a check, the real error goes back and the agent fixes its own code.</p>
            </div>
          </li>
          <li>
            <span className="num">04</span>
            <div>
              <h3>Show the receipts</h3>
              <p>A screenshot captured in the sandbox, the redirect chain, forms and where they send your details, then a plain verdict. The VM is destroyed.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className="features" aria-labelledby="what-title">
        <div className="center-head">
          <h2 id="what-title">What gets inspected</h2>
          <p>Evidence the trusted helper collects itself, so the verdict does not depend on how good the generated code was.</p>
        </div>
        <div className="feature-grid">
          <article className="feature">
            <div className="feature-top">
              <span className="icon" aria-hidden="true">↗</span>
              <span className="tag">Redirects</span>
            </div>
            <h3>Where it really goes</h3>
            <p>Every hop is re-checked against the network policy before the browser may follow it.</p>
          </article>
          <article className="feature">
            <div className="feature-top">
              <span className="icon" aria-hidden="true">◎</span>
              <span className="tag">Identity</span>
            </div>
            <h3>Who it claims to be</h3>
            <p>Title, logos and branding compared with the domain you would actually be on.</p>
          </article>
          <article className="feature">
            <div className="feature-top">
              <span className="icon" aria-hidden="true">⌨</span>
              <span className="tag">Forms</span>
            </div>
            <h3>What it asks for</h3>
            <p>Password, card and PIN fields, including hidden shadow-DOM forms, and where they post.</p>
          </article>
          <article className="feature">
            <div className="feature-top">
              <span className="icon" aria-hidden="true">!</span>
              <span className="tag">Pressure</span>
            </div>
            <h3>How it pushes you</h3>
            <p>Urgency language and hidden text aimed at AI tools, kept as evidence and never obeyed.</p>
          </article>
        </div>
      </section>

      <section className="examples" aria-labelledby="examples-title">
        <div className="section-head">
          <div>
            <span className="eyebrow plain">Safe to try</span>
            <h2 id="examples-title">Demonstration pages</h2>
          </div>
          <p>Harmless pages controlled by this project. Nothing on them collects data.</p>
        </div>
        <ul className="fixture-list">
          {(status?.fixtures ?? []).map((f) => (
            <li key={f.key} className="fixture">
              <div className="fixture-body">
                <strong>{f.label}</strong>
                <code>{f.path}</code>
                <span className="expect">Expected: {f.expect}</span>
              </div>
              <div className="fixture-actions">
                {live && f.url.startsWith("http") && (
                  <button type="button" className="secondary" onClick={() => fillForLive(f.url)}>
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
            <div>
              <span className="eyebrow plain">Receipts</span>
              <h2 id="demo-title">Recorded live inspections</h2>
            </div>
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

      <section className="cta" aria-labelledby="cta-title">
        <span className="eyebrow on-dark">Proof checked · Clicks avoided</span>
        <h2 id="cta-title">Got a weird link? Send it to the sandbox, not your phone.</h2>
        <div className="cta-row">
          <button type="button" className="light" onClick={() => fillForLive(url)}>
            Inspect a link <span aria-hidden="true">→</span>
          </button>
          <span className="cta-note">Read-only visit · nothing is submitted · VM destroyed afterwards</span>
        </div>
        <div className="cta-ring" aria-hidden="true" />
      </section>
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
            {s.repairDemo && <span className="mode-tag seeded">Repair demo</span>}
            <span className="scan-url">{s.url}</span>
            {s.verdict ? <VerdictPill verdict={s.verdict} /> : <span className="muted">{s.status}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
