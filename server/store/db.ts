import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ScanMode = "live" | "fixture" | "recorded";
export type ScanStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "blocked";

export interface ScanRow {
  id: string;
  owner: string;
  mode: ScanMode;
  url_redacted: string;
  url_full: string;
  status: ScanStatus;
  verdict: string | null;
  report_json: string | null;
  error: string | null;
  sandbox_id: string | null;
  repair_demo: number;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface EventRow {
  scan_id: string;
  seq: number;
  ts: string;
  stage: string;
  level: string;
  message: string;
  data_json: string | null;
}

export interface AttemptRow {
  id: string;
  scan_id: string;
  n: number;
  author: "model" | "seeded";
  script: string;
  script_sha256: string;
  explanation: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout_excerpt: string | null;
  stderr_excerpt: string | null;
  outcome: string | null;
  failed_checks_json: string | null;
  duration_ms: number | null;
}

export interface ArtifactRow {
  id: string;
  scan_id: string;
  kind: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  path: string;
  created_at: string;
}

const now = () => new Date().toISOString();

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, mode TEXT NOT NULL,
        url_redacted TEXT NOT NULL, url_full TEXT NOT NULL,
        status TEXT NOT NULL, verdict TEXT, report_json TEXT, error TEXT, sandbox_id TEXT,
        repair_demo INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS scans_owner ON scans(owner, created_at);
      CREATE TABLE IF NOT EXISTS events (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, ts TEXT NOT NULL, stage TEXT NOT NULL, level TEXT NOT NULL,
        message TEXT NOT NULL, data_json TEXT, PRIMARY KEY (scan_id, seq)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        n INTEGER NOT NULL, author TEXT NOT NULL, script TEXT NOT NULL, script_sha256 TEXT NOT NULL,
        explanation TEXT, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER,
        stdout_excerpt TEXT, stderr_excerpt TEXT, outcome TEXT, failed_checks_json TEXT, duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        width INTEGER, height INTEGER, path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, created_at TEXT NOT NULL,
        destroyed_at TEXT, state TEXT NOT NULL
      );
    `);
  }

  createScan(input: { owner: string; mode: ScanMode; urlFull: string; urlRedacted: string; repairDemo: boolean; id?: string }): ScanRow {
    const id = input.id ?? `scn_${randomUUID().replace(/-/g, "")}`;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO scans (id, owner, mode, url_redacted, url_full, status, repair_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.owner, input.mode, input.urlRedacted, input.urlFull, input.repairDemo ? 1 : 0, ts, ts);
    return this.getScan(id)!;
  }

  getScan(id: string): ScanRow | undefined {
    return this.db.prepare("SELECT * FROM scans WHERE id = ?").get(id) as ScanRow | undefined;
  }

  listScans(owner: string, limit = 20): ScanRow[] {
    return this.db.prepare("SELECT * FROM scans WHERE owner = ? ORDER BY created_at DESC LIMIT ?").all(owner, limit) as unknown as ScanRow[];
  }

  updateScan(id: string, patch: Partial<Pick<ScanRow, "status" | "verdict" | "report_json" | "error" | "sandbox_id" | "finished_at" | "cancel_requested">>) {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as string | number | null);
    this.db.prepare(`UPDATE scans SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }

  countLiveScansSince(sinceIso: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM scans WHERE mode = 'live' AND created_at >= ?").get(sinceIso) as { c: number };
    return r.c;
  }

  countOwnerLiveScansSince(owner: string, sinceIso: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM scans WHERE mode = 'live' AND owner = ? AND created_at >= ?").get(owner, sinceIso) as { c: number };
    return r.c;
  }

  activeLiveScans(): ScanRow[] {
    return this.db.prepare("SELECT * FROM scans WHERE mode = 'live' AND status IN ('queued','running')").all() as unknown as ScanRow[];
  }

  appendEvent(scanId: string, stage: string, level: "info" | "warn" | "error" | "success", message: string, data?: unknown): EventRow {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE scan_id = ?").get(scanId) as { next: number };
    const ev: EventRow = { scan_id: scanId, seq: row.next, ts: now(), stage, level, message, data_json: data === undefined ? null : JSON.stringify(data) };
    this.db
      .prepare("INSERT INTO events (scan_id, seq, ts, stage, level, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ev.scan_id, ev.seq, ev.ts, ev.stage, ev.level, ev.message, ev.data_json);
    return ev;
  }

  listEvents(scanId: string, afterSeq = 0): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE scan_id = ? AND seq > ? ORDER BY seq").all(scanId, afterSeq) as unknown as EventRow[];
  }

  startAttempt(scanId: string, n: number, author: "model" | "seeded", script: string, sha: string, explanation: string | null): string {
    const id = `att_${randomUUID().replace(/-/g, "")}`;
    this.db
      .prepare("INSERT INTO attempts (id, scan_id, n, author, script, script_sha256, explanation, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, scanId, n, author, script, sha, explanation, now());
    return id;
  }

  finishAttempt(id: string, patch: { exit_code: number | null; stdout_excerpt: string; stderr_excerpt: string; outcome: string; failed_checks: string[]; duration_ms: number }) {
    this.db
      .prepare(
        "UPDATE attempts SET finished_at = ?, exit_code = ?, stdout_excerpt = ?, stderr_excerpt = ?, outcome = ?, failed_checks_json = ?, duration_ms = ? WHERE id = ?",
      )
      .run(now(), patch.exit_code, patch.stdout_excerpt, patch.stderr_excerpt, patch.outcome, JSON.stringify(patch.failed_checks), patch.duration_ms, id);
  }

  listAttempts(scanId: string): AttemptRow[] {
    return this.db.prepare("SELECT * FROM attempts WHERE scan_id = ? ORDER BY n").all(scanId) as unknown as AttemptRow[];
  }

  addArtifact(a: Omit<ArtifactRow, "id" | "created_at">): ArtifactRow {
    const id = `art_${randomUUID().replace(/-/g, "")}`;
    const ts = now();
    this.db
      .prepare("INSERT INTO artifacts (id, scan_id, kind, mime, bytes, sha256, width, height, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.scan_id, a.kind, a.mime, a.bytes, a.sha256, a.width, a.height, a.path, ts);
    return { ...a, id, created_at: ts };
  }

  getArtifact(scanId: string, id: string): ArtifactRow | undefined {
    return this.db.prepare("SELECT * FROM artifacts WHERE scan_id = ? AND id = ?").get(scanId, id) as ArtifactRow | undefined;
  }

  listArtifacts(scanId: string): ArtifactRow[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE scan_id = ? ORDER BY created_at").all(scanId) as unknown as ArtifactRow[];
  }

  recordSandbox(id: string, scanId: string) {
    this.db.prepare("INSERT OR REPLACE INTO sandboxes (id, scan_id, created_at, state) VALUES (?, ?, ?, 'active')").run(id, scanId, now());
  }

  markSandboxDestroyed(id: string) {
    this.db.prepare("UPDATE sandboxes SET destroyed_at = ?, state = 'destroyed' WHERE id = ?").run(now(), id);
  }

  activeSandboxes(): Array<{ id: string; scan_id: string }> {
    return this.db.prepare("SELECT id, scan_id FROM sandboxes WHERE state = 'active'").all() as Array<{ id: string; scan_id: string }>;
  }
}
