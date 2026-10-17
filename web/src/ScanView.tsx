import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Report, type ScanDetail, type ScanEvent, type Status } from "./api";

const STAGE_ORDER = ["validate", "prepare", "write", "run", "repair", "collect", "report", "cleanup"] as const;
const STAGE_LABEL: Record<string, string> = {
  validate: "Validating URL",
  prepare: "Preparing isolated browser",
  write: "Writing inspection code",
  run: "Running inspection",
  repair: "Repairing code",
  collect: "Collecting evidence",
  report: "Preparing report",
  cleanup: "Cleaning up",
};
const stageOf = (s: string) => (s === "policy" ? "prepare" : s);
const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "blocked"]);

export function VerdictPill({ verdict }: { verdict: string }) {
  const cls = verdict === "High risk" ? "high" : verdict === "Suspicious" ? "medium" : verdict === "Inconclusive" ? "unknown" : "low";
  return <span className={`verdict-pill ${cls}`}>{verdict}</span>;
}

export function ScanView({ id, status, onBack }: { id: string; status: Status | null; onBack: () => void }) {
  const [detail, setDetail] = useState<ScanDetail | null>(null);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"live" | "reconnecting" | "closed">("live");
  const lastSeq = useRef(0);

  // Initial load, then stream. EventSource resumes from Last-Event-ID on reconnect,
  // and a page refresh replays the stored history from the start.
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    lastSeq.current = 0;
    setEvents([]);
    setDetail(null);
    setError(null);

    const refresh = () =>
      api.scan(id).then(
        (d) => !cancelled && setDetail(d),
        (e: Error) => !cancelled && setError(e.message),
      );

    refresh().then(() => {
      if (cancelled) return;
      es = new EventSource(`/api/scans/${encodeURIComponent(id)}/stream`);
      es.addEventListener("scan-event", (msg) => {
        const ev = JSON.parse((msg as MessageEvent).data) as ScanEvent;
        if (ev.seq <= lastSeq.current) return;
        lastSeq.current = ev.seq;
        setEvents((prev) => [...prev, ev]);
        setConnection("live");
        if (ev.stage === "run" || ev.stage === "repair" || ev.stage === "report") void refresh();
      });
      es.addEventListener("done", () => {
        setConnection("closed");
        es?.close();
        void refresh();
      });
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) setConnection("closed");
        else setConnection("reconnecting");
      };
    });
    // Polling fallback: some proxies (e.g. a CDN in front of the API) buffer
    // event streams. Events are de-duplicated by sequence number.
    const poll = setInterval(async () => {
      if (cancelled) return;
      try {
        const { status, events: fresh } = await api.events(id, lastSeq.current);
        const added = fresh.filter((e) => e.seq > lastSeq.current);
        if (added.length) {
          lastSeq.current = added[added.length - 1].seq;
          setEvents((prev) => [...prev, ...added]);
          void refresh();
        }
        if (!["queued", "running"].includes(status)) {
          clearInterval(poll);
          void refresh();
        }
      } catch {
        /* transient; SSE or the next poll will catch up */
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      es?.close();
    };
  }, [id]);

  const scan = detail?.scan;
  const report = scan?.report;
  const running = scan ? !TERMINAL.has(scan.status) : true;

  const stages = useMemo(() => computeStages(events, scan?.status ?? "running"), [events, scan?.status]);

  if (error) {
    return (
      <div className="scan-page">
        <button className="link-back" onClick={onBack}>
          ← New inspection
        </button>
        <p className="notice error">{error === "Not found." ? "This inspection does not exist or belongs to another browser session." : error}</p>
      </div>
    );
  }

  return (
    <div className="scan-page">
      <div className="scan-head">
        <button className="link-back" onClick={onBack}>
          ← New inspection
        </button>
        <div className="scan-title">
          <ModeTag mode={scan?.mode ?? "live"} />
          {scan?.repairDemo && <span className="mode-tag seeded">Repair demonstration (seeded defect)</span>}
          <code className="scan-target" title="Sensitive query values are redacted">
            {scan?.url ?? "…"}
          </code>
        </div>
        {running && scan?.mode === "live" && (
          <button className="ghost danger" onClick={() => api.cancel(id)}>
            Cancel inspection
          </button>
        )}
      </div>

      {scan && <Kpis detail={detail!} events={events} running={running} />}

      <div className="scan-grid">
        <aside className="timeline-col" aria-label="Investigation progress">
          <h2 className="col-title">Investigation</h2>
          <ol className="stages" aria-live="polite">
            {STAGE_ORDER.map((s) => (
              <li key={s} className={`stage ${stages[s]}`}>
                <span className="stage-dot" aria-hidden="true" />
                <span className="stage-name">{STAGE_LABEL[s]}</span>
                <span className="sr-only">{stages[s]}</span>
                {stages[s] === "skipped" && <span className="stage-note">not needed</span>}
              </li>
            ))}
          </ol>
          {running && connection === "reconnecting" && <p className="hint">Reconnecting to live updates…</p>}
          <details className="log" open={running}>
            <summary>Activity log ({events.length})</summary>
            <ol>
              {events.map((e) => (
                <li key={e.seq} className={`log-${e.level}`}>
                  <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time>
                  <span>{e.message}</span>
                </li>
              ))}
            </ol>
          </details>
        </aside>

        <section className="evidence-col" aria-label="Findings">
          {!report && <Pending running={running} scanStatus={scan?.status} error={scan?.error ?? null} />}
          {report && scan && <Findings report={report} scanId={scan.id} />}
          {detail && <Technical detail={detail} events={events} status={status} />}
        </section>
      </div>
    </div>
  );
}

function Kpis({ detail, events, running }: { detail: ScanDetail; events: ScanEvent[]; running: boolean }) {
  const scan = detail.scan;
  const report = scan.report;
  const attempts = detail.attempts;
  const passed = attempts.find((a) => a.outcome === "passed");
  const policy = events.find((e) => e.stage === "policy" && e.data && typeof e.data === "object" && "effective" in (e.data as object));
  const rules = policy ? ((policy.data as { effective?: string[] }).effective?.length ?? 0) : null;
  const end = scan.finishedAt ? new Date(scan.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(scan.createdAt).getTime()) / 1000));
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return (
    <div className="kpis" role="list" aria-label="Inspection summary">
      <div className="kpi" role="listitem">
        <span className="kpi-label">Verdict</span>
        <span className="kpi-value">{report ? <VerdictPill verdict={report.verdict} /> : running ? "In progress" : scan.status}</span>
      </div>
      <div className="kpi" role="listitem">
        <span className="kpi-label">Script attempts</span>
        <span className="kpi-value">
          {attempts.length}
          <small>{passed ? ` · passed on #${passed.n}` : running ? " · running" : " · none passed"}</small>
        </span>
      </div>
      <div className="kpi" role="listitem">
        <span className="kpi-label">Egress rules</span>
        <span className="kpi-value">
          {rules ?? (scan.mode === "fixture" ? "n/a" : "…")}
          <small>{rules ? " · verified" : ""}</small>
        </span>
      </div>
      <div className="kpi" role="listitem">
        <span className="kpi-label">{scan.mode === "live" && running ? "Elapsed" : "Duration"}</span>
        <span className="kpi-value">{scan.mode === "fixture" ? "offline" : duration}</span>
      </div>
    </div>
  );
}

function ModeTag({ mode }: { mode: string }) {
  const label = mode === "live" ? "Live CreateOS execution" : mode === "recorded" ? "Recorded evidence from a live run" : "Offline fixture (no sandbox, no model)";
  return <span className={`mode-tag ${mode}`}>{label}</span>;
}

function Pending({ running, scanStatus, error }: { running: boolean; scanStatus?: string; error: string | null }) {
  return (
    <div className="card pending">
      <div className="preview-frame placeholder" aria-hidden="true">
        <div className="scan-lines" />
      </div>
      <p>{running ? "The isolated browser is visiting the link. Findings appear here when the evidence is verified." : `Inspection ${scanStatus}. ${error ?? ""}`}</p>
    </div>
  );
}

function Findings({ report, scanId }: { report: Report; scanId: string }) {
  const tone = report.verdict === "High risk" ? "high" : report.verdict === "Suspicious" ? "medium" : report.verdict === "Inconclusive" ? "unknown" : "low";
  return (
    <>
      <div className={`card verdict-card ${tone}`}>
        <div className="verdict-top">
          <VerdictPill verdict={report.verdict} />
          {report.status !== "completed" && <span className="partial-tag">{report.status === "partial" ? "Partial inspection" : "Inspection incomplete"}</span>}
        </div>
        <p className="verdict-summary">{report.summary}</p>
        <p className="recommendation">
          <strong>What to do: </strong>
          {report.recommendation}
        </p>
      </div>

      <figure className="card preview">
        <figcaption>
          <span>Screenshot evidence</span>
          {report.preview.available && report.preview.width && (
            <span className="muted">
              {report.preview.width}×{report.preview.height} · {report.executionMode === "fixture" ? "fixture image recorded locally (not CreateOS)" : "captured inside the CreateOS sandbox"}
            </span>
          )}
        </figcaption>
        {report.preview.available && report.preview.artifactId ? (
          <div className="browser">
            <div className="browser-bar" aria-hidden="true">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="address">{report.finalUrl ?? report.originalUrl ?? ""}</span>
            </div>
            <div className="preview-frame">
              <img src={api.artifactUrl(scanId, report.preview.artifactId)} alt={`Screenshot of ${report.title ?? "the inspected page"} captured in the sandbox`} width={report.preview.width} height={report.preview.height} />
            </div>
          </div>
        ) : (
          <div className="preview-frame unavailable" role="img" aria-label="Preview unavailable">
            <strong>Preview unavailable</strong>
            <span>{report.preview.reason ?? "The screenshot could not be captured."}</span>
            <span className="muted">Because there is no verified screenshot, this inspection is classified as {report.status === "partial" ? "partial" : "inconclusive"}.</span>
          </div>
        )}
      </figure>

      <div className="card facts">
        <h3>Where the link goes</h3>
        <dl>
          <dt>Original link</dt>
          <dd>
            <code>{report.originalUrl ?? "—"}</code>
          </dd>
          <dt>Final destination</dt>
          <dd>
            <code>{report.finalUrl ?? "Not reached (navigation stopped)"}</code>
          </dd>
          {report.title && (
            <>
              <dt>Page title</dt>
              <dd>{report.title}</dd>
            </>
          )}
          {report.claimedIdentity && (
            <>
              <dt>Claims to be</dt>
              <dd>
                {report.claimedIdentity.name}{" "}
                <span className={report.claimedIdentity.supported ? "ok-tag" : "bad-tag"}>{report.claimedIdentity.supported ? "matches the domain" : "does not match the domain"}</span>
              </dd>
            </>
          )}
        </dl>
        {report.redirectChain.length > 0 && (
          <>
            <h4>Observed redirect chain</h4>
            <ol className="chain">
              {report.redirectChain.map((h, i) => (
                <li key={i}>
                  <span className="hop-status">{h.status ?? "—"}</span>
                  <code>{h.url}</code>
                  <span className="muted hop-kind">{h.kind === "initial" ? "start" : h.kind === "client" ? "page script" : "redirect"}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {report.blockedDestinations.length > 0 && (
          <>
            <h4>Blocked destinations</h4>
            <ul className="blocked">
              {report.blockedDestinations.map((b, i) => (
                <li key={i}>
                  <code>{b.url}</code> <span>{b.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {report.loginForms.length > 0 && (
          <>
            <h4>Login forms</h4>
            <ul className="forms">
              {report.loginForms.map((f, i) => (
                <li key={i}>
                  Password form, {f.method} to <code>{f.action ?? "unknown"}</code> {f.crossOrigin && <span className="bad-tag">other website</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <h3>Warning signs</h3>
        {report.warningSigns.length === 0 ? (
          <p className="muted">None observed during this visit.</p>
        ) : (
          <ul className="signs">
            {report.warningSigns.map((s) => (
              <li key={s.id} className={`sign ${s.severity}`}>
                <span className="sev">{s.severity}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card two-col">
        <div>
          <h3>Coverage</h3>
          <ul className="plain">
            {report.coverage.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Limitations</h3>
          <ul className="plain">
            {report.limitations.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function Technical({ detail, events, status }: { detail: ScanDetail; events: ScanEvent[]; status: Status | null }) {
  const policy = events.filter((e) => e.stage === "policy" || (e.stage === "prepare" && e.data));
  return (
    <details className="card technical">
      <summary>Technical evidence and execution history</summary>
      <dl className="tech-meta">
        <dt>Scan</dt>
        <dd>
          <code>{detail.scan.id}</code>
        </dd>
        {detail.sandboxId && (
          <>
            <dt>CreateOS sandbox</dt>
            <dd>
              <code>{detail.sandboxId}</code>
            </dd>
          </>
        )}
        {status && detail.scan.mode === "live" && (
          <>
            <dt>Runtime</dt>
            <dd>
              {status.sandbox.rootfs} · {status.sandbox.shape} · {status.createosRegion} · model {status.model.provider}/{status.model.id} via eve
            </dd>
          </>
        )}
        {detail.artifacts.map((a) => (
          <div key={a.id} className="contents">
            <dt>Artifact</dt>
            <dd>
              {a.kind} · {a.mime} · {a.bytes} bytes · sha256 <code>{a.sha256.slice(0, 16)}…</code>
            </dd>
          </div>
        ))}
      </dl>
      {policy.length > 0 && (
        <>
          <h4>Network policy</h4>
          <ul className="plain">
            {policy.map((e) => (
              <li key={e.seq}>
                {e.message}
                {e.data !== undefined && <pre className="code small">{JSON.stringify(e.data, null, 2)}</pre>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Script versions ({detail.attempts.length})</h4>
      {detail.attempts.length === 0 && <p className="muted">No script was executed for this inspection.</p>}
      {detail.attempts.map((a) => (
        <details key={a.n} className={`attempt ${a.outcome ?? "running"}`} open={detail.attempts.length <= 2}>
          <summary>
            Attempt {a.n} · {a.author === "seeded" ? "seeded draft (deliberate defect)" : "written by the agent"} · {a.outcome ?? "running"}
            {a.exitCode !== null && ` · exit ${a.exitCode}`}
            {a.durationMs !== null && ` · ${(a.durationMs / 1000).toFixed(1)}s`}
          </summary>
          {a.explanation && <p className="explain-line">{a.explanation}</p>}
          {a.failedChecks.length > 0 && (
            <ul className="failed-checks">
              {a.failedChecks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {a.stderr && (
            <>
              <h5>stderr (untrusted output)</h5>
              <pre className="code small">{a.stderr}</pre>
            </>
          )}
          <h5>
            Code <span className="muted">sha256 {a.sha256.slice(0, 12)}</span>
          </h5>
          <pre className="code">{a.script}</pre>
        </details>
      ))}
    </details>
  );
}

type StageState = "pending" | "active" | "done" | "error" | "skipped";

function computeStages(events: ScanEvent[], scanStatus: string): Record<string, StageState> {
  const out: Record<string, StageState> = Object.fromEntries(STAGE_ORDER.map((s) => [s, "pending"]));
  const seen = new Set<string>();
  const errored = new Set<string>();
  let last: string | null = null;
  for (const e of events) {
    const s = stageOf(e.stage);
    if (!(s in out)) continue;
    seen.add(s);
    if (e.level === "error") errored.add(s);
    last = s;
  }
  const finished = TERMINAL.has(scanStatus);
  const lastIdx = last ? STAGE_ORDER.indexOf(last as (typeof STAGE_ORDER)[number]) : -1;
  STAGE_ORDER.forEach((s, i) => {
    if (errored.has(s)) out[s] = "error";
    else if (seen.has(s)) out[s] = !finished && s === last ? "active" : "done";
    else if (finished || i < lastIdx) out[s] = "skipped";
  });
  return out;
}
