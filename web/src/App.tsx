import { useCallback, useEffect, useState } from "react";
import { api, type ScanSummary, type Status } from "./api";
import { Home } from "./Home";
import { ScanView } from "./ScanView";
import { Compass } from "./Compass";

function currentScanId(): string | null {
  const m = window.location.pathname.match(/^\/scan\/([A-Za-z0-9_]+)$/);
  return m ? m[1] : null;
}

export function App() {
  const [scanId, setScanId] = useState<string | null>(currentScanId);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ScanSummary[]>([]);
  const [demos, setDemos] = useState<ScanSummary[]>([]);

  useEffect(() => {
    const onPop = () => setScanId(currentScanId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api.status().then(setStatus, (e: Error) => setStatusError(e.message));
    api.demos().then((d) => setDemos(d.scans), () => setDemos([]));
  }, []);

  useEffect(() => {
    if (!scanId) api.scans().then((d) => setRecent(d.scans), () => setRecent([]));
  }, [scanId]);

  const navigate = useCallback((id: string | null) => {
    window.history.pushState({}, "", id ? `/scan/${id}` : "/");
    setScanId(id);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <button className="brand" onClick={() => navigate(null)} aria-label="Teger Scout home">
          <span className="brand-mark">
            <Compass size={28} />
          </span>
          <span>
            <strong>Teger Scout</strong>
            <em>See where a link leads before you open it.</em>
          </span>
        </button>
        <nav className="top-nav" aria-label="Status">
          <ModeBadge status={status} />
          {scanId && (
            <button className="primary small" onClick={() => navigate(null)}>
              New inspection <span aria-hidden="true">→</span>
            </button>
          )}
        </nav>
      </header>
      <main id="main">
        {statusError && <p className="notice error">Could not reach the Teger Scout service: {statusError}</p>}
        {scanId ? <ScanView id={scanId} status={status} onBack={() => navigate(null)} /> : <Home status={status} recent={recent} demos={demos} onOpen={navigate} />}
      </main>
      <footer className="foot">
        <span className="foot-brand">
          <span className="brand-mark small">
            <Compass size={18} />
          </span>
          Teger Scout · DUKERS LTD
        </span>
        <span>CreateOS × Stripe Projects hackathon 2026 · Inspections are read-only observations, not guarantees of safety.</span>
      </footer>
    </div>
  );
}

function ModeBadge({ status }: { status: Status | null }) {
  if (!status) return <span className="mode-badge muted">Connecting…</span>;
  return status.liveAvailable ? (
    <span className="mode-badge live" title={`CreateOS ${status.createosRegion ?? ""} · ${status.sandbox.rootfs} · ${status.sandbox.shape}`}>
      <span className="dot" aria-hidden="true" /> Live CreateOS execution
    </span>
  ) : (
    <span className="mode-badge offline">Offline fixture mode</span>
  );
}
