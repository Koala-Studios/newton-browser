import fs from "node:fs";
import path from "node:path";
import { EngineError } from "@newton-browser/core";

type RecordValue = Record<string, unknown>;
type Send = (method: string, params?: RecordValue) => Promise<RecordValue>;

export type DownloadState = "in_progress" | "completed" | "canceled";
export type DownloadRecord = { downloadId: string; filename: string; url: string; state: DownloadState; receivedBytes: number; totalBytes: number | null };

const MAX_RECORDS = 64;
const DOWNLOAD_ID = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * Files an owned browser downloads. Headless Chromium refuses downloads until a client allows them, so a click on a
 * download link did nothing. Each file lands in the session's own folder under its download id, which the host reads.
 */
export class SessionDownloads {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly directory: string | undefined;
  constructor(directory: string | undefined) { this.directory = directory; }

  get enabled(): boolean { return this.directory !== undefined; }

  async enable(send: Send): Promise<void> {
    if (!this.directory) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.directory, eventsEnabled: true });
  }

  handle(event: { method: string; params: RecordValue }): void {
    if (!this.directory) return;
    if (event.method === "Browser.downloadWillBegin") {
      const downloadId = typeof event.params.guid === "string" ? event.params.guid : "";
      if (!DOWNLOAD_ID.test(downloadId)) return;
      if (this.records.size >= MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
      this.records.set(downloadId, { downloadId, filename: safeFilename(event.params.suggestedFilename),
        url: typeof event.params.url === "string" ? event.params.url.slice(0, 2048) : "", state: "in_progress", receivedBytes: 0, totalBytes: null });
    } else if (event.method === "Browser.downloadProgress") {
      const record = typeof event.params.guid === "string" ? this.records.get(event.params.guid) : undefined;
      if (!record) return;
      const received = Number(event.params.receivedBytes), total = Number(event.params.totalBytes);
      if (Number.isSafeInteger(received) && received >= 0) record.receivedBytes = received;
      if (Number.isSafeInteger(total) && total > 0) record.totalBytes = total;
      if (event.params.state === "completed") record.state = "completed";
      else if (event.params.state === "canceled") record.state = "canceled";
    }
  }

  list(limit: number): { downloads: DownloadRecord[]; total: number } {
    if (!this.directory) throw new EngineError("unsupported_capability");
    const all = [...this.records.values()];
    return { downloads: all.slice(-limit).map(record => ({ ...record })), total: all.length };
  }

  /** Host-only: the saved file of a completed download. Never returned to the model. */
  file(downloadId: string): { path: string; filename: string; bytes: number } {
    if (!this.directory) throw new EngineError("unsupported_capability");
    const record = DOWNLOAD_ID.test(downloadId) ? this.records.get(downloadId) : undefined;
    if (!record) throw new EngineError("invalid_arguments", "download_unknown");
    if (record.state !== "completed") throw new EngineError("invalid_arguments", record.state === "canceled" ? "download_canceled" : "download_in_progress");
    const file = path.join(this.directory, downloadId);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new EngineError("invalid_arguments", "download_missing");
    return { path: file, filename: record.filename, bytes: stat.size };
  }
}

/** The site's suggested name, as a single safe path segment. */
function safeFilename(value: unknown): string {
  const name = (typeof value === "string" ? value : "").replace(/[\\/\x00-\x1f\x7f]/gu, "_").trim().slice(0, 200);
  return name && name !== "." && name !== ".." ? name : "download";
}
