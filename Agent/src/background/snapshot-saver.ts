/**
 * Snapshot Saver — Abstracts file persistence for both local (client loop)
 * and server (quick trial) modes.
 *
 * Both modes share the same contract:
 *   1. Save task_status.json
 *   2. Save accumulated snapshots (screenshots, DOM, progress.json)
 *   3. Optionally write protocol signals (_done.json, _agent_done.json, etc.)
 *
 * `LocalSnapshotSaver`  — writes files via chrome.downloads (for resolver client loop)
 * `ServerSnapshotSaver` — uploads files via POST /trajectoria (for quick trial)
 */

import { getAccumulatedSnapshots, clearAccumulatedSnapshots, type AccumulatedSnapshot } from "@eko-ai/eko";

// ── Interface ────────────────────────────────────────────────────────────────

export interface SnapshotSaveResult {
  saved: number;
  failed: number;
  savedFilenames: string[];
}

export interface ISnapshotSaver {
  /** Save a single file (JSON or binary). `data` is base64-encoded. */
  saveFile(filename: string, data: string, mimeType: string): Promise<void>;

  /** Save all accumulated snapshots (screenshots, DOM, progress.json). */
  saveAccumulatedSnapshots(): Promise<SnapshotSaveResult>;

  /** Save task_status.json from a plain object. */
  saveTaskStatus(taskStatus: Record<string, unknown>): Promise<void>;

  /**
   * Write the _done.json completion signal.
   * Only meaningful for the local saver (resolver client loop).
   * Server saver is a no-op.
   */
  writeDoneSignal(result: DoneSignalPayload): Promise<void>;

  /**
   * Write _agent_done.json early signal.
   * Only meaningful for the local saver.
   */
  writeAgentDoneSignal(status: string): Promise<void>;

  /**
   * Write _prepare_done.json setup-complete signal.
   * Only meaningful for the local saver.
   */
  writePrepareDoneSignal(): Promise<void>;
}

export interface DoneSignalPayload {
  success: boolean;
  status: string;
  error?: string;
  sessionId?: string;
  fileCount: number;
  files?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a plain object to base64-encoded JSON string. */
function jsonToBase64(obj: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
}

/**
 * Generate a filename for a snapshot based on its type and context.
 */
export function generateSnapshotFilename(snapshot: AccumulatedSnapshot): string {
  const { stepNumber, toolCallId, type, mimeType } = snapshot;

  if (!stepNumber || !toolCallId) {
    return snapshot.filename;
  }

  const step = stepNumber.padStart(3, '0');
  const shortId = toolCallId;

  // Filenames must include '_after_' and '_complete' for the trajectoria viewer
  // to recognize them as step screenshots/DOM (see session-detail-page.ts).
  switch (type) {
    case 'screenshot': {
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      return `${step}_after_${shortId}_complete.${ext}`;
    }
    case 'pseudo_dom':
      return `${step}_after_${shortId}_complete.pseudo.dom`;
    case 'full_dom':
      return `${step}_after_${shortId}_complete.html`;
    case 'progress':
      return 'progress.json';
    default:
      if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
        const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
        return `${step}_after_${shortId}_complete.${ext}`;
      }
      return snapshot.filename;
  }
}

// ── Local Saver (chrome.downloads) ──────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 90_000;
const BATCH_SIZE = 5;

/**
 * Save a file locally via chrome.downloads.download() with a data URL.
 */
function downloadFile(
  localDir: string,
  filename: string,
  data: string,
  mimeType: string,
): Promise<void> {
  const filePath = `${localDir}/${filename}`;
  console.log(`[LocalSave] Attempting to save: ${filePath} (${data.length} bytes base64, mime=${mimeType})`);

  const dataUrl = `data:${mimeType};base64,${data}`;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[LocalSave] Download timed out for ${filePath}`);
      reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
    }, DOWNLOAD_TIMEOUT_MS);

    chrome.downloads.download(
      { url: dataUrl, filename: filePath, saveAs: false, conflictAction: 'overwrite' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            console.error(`[LocalSave] Failed to save ${filePath}: ${chrome.runtime.lastError.message}`);
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        if (downloadId === undefined) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('downloadId is undefined'));
          }
          return;
        }

        const onChanged = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(`Download interrupted: ${(delta as any).error?.current || 'unknown'}`));
            }
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);

        // Edge case: download may have already completed
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (settled) return;
          const item = results?.[0];
          if (item?.state === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            settled = true; clearTimeout(timer); resolve();
          } else if (item?.state === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            settled = true; clearTimeout(timer);
            reject(new Error(`Download interrupted: ${item.error || 'unknown'}`));
          }
        });
      },
    );
  });
}

export class LocalSnapshotSaver implements ISnapshotSaver {
  constructor(private readonly localDir: string) {}

  async saveFile(filename: string, data: string, mimeType: string): Promise<void> {
    await downloadFile(this.localDir, filename, data, mimeType);
  }

  async saveAccumulatedSnapshots(): Promise<SnapshotSaveResult> {
    const snapshots = getAccumulatedSnapshots();
    console.log(`[LocalSave] saveAccumulatedSnapshots: ${snapshots.length} snapshots (types: ${snapshots.map(s => s.type || s.filename).join(', ')})`);
    if (snapshots.length === 0) {
      return { saved: 0, failed: 0, savedFilenames: [] };
    }

    const tasks = snapshots.map((s) => ({
      filename: generateSnapshotFilename(s),
      snapshot: s,
    }));

    const savedFilenames: string[] = [];
    let saved = 0;
    let failed = 0;

    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(({ filename, snapshot }) =>
          downloadFile(this.localDir, filename, snapshot.data, snapshot.mimeType)
            .then(() => ({ filename, ok: true as const })),
        ),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value.ok) {
          saved++;
          savedFilenames.push(r.value.filename);
        } else {
          failed++;
          console.error(`[LocalSave] Failed to save ${batch[j].filename}: ${r.status === 'rejected' ? r.reason : 'unknown'}`);
        }
      }
    }

    console.log(`[LocalSave] Saved ${saved} snapshots, ${failed} failed`);
    clearAccumulatedSnapshots();
    return { saved, failed, savedFilenames };
  }

  async saveTaskStatus(taskStatus: Record<string, unknown>): Promise<void> {
    await downloadFile(this.localDir, 'task_status.json', jsonToBase64(taskStatus), 'application/json');
  }

  async writeDoneSignal(result: DoneSignalPayload): Promise<void> {
    const done = {
      protocolVersion: '1.0',
      ...result,
      agentType: 'websape-extension',
      agentVersion: chrome.runtime.getManifest?.()?.version || '1.0',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    await downloadFile(this.localDir, '_done.json', jsonToBase64(done), 'application/json');
    console.log(`[LocalSave] _done.json written`);
  }

  async writeAgentDoneSignal(status: string): Promise<void> {
    await downloadFile(this.localDir, '_agent_done.json', jsonToBase64({ status, timestamp: new Date().toISOString() }), 'application/json');
    console.log(`[LocalSave] _agent_done.json written (status=${status})`);
  }

  async writePrepareDoneSignal(): Promise<void> {
    await downloadFile(this.localDir, '_prepare_done.json', jsonToBase64({ timestamp: new Date().toISOString() }), 'application/json');
    console.log(`[LocalSave] _prepare_done.json written`);
  }
}

// ── Server Saver (POST /trajectoria) ────────────────────────────────────────

export class ServerSnapshotSaver implements ISnapshotSaver {
  constructor(
    private readonly serverUrl: string,
    private readonly sessionId: string,
    private readonly resolverTaskId: string,
    private readonly dataset: string,
  ) {}

  /** POST a single file to the trajectoria endpoint. */
  async saveFile(filename: string, data: string, _mimeType: string): Promise<void> {
    try {
      const resp = await fetch(`${this.serverUrl}/trajectoria`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          resolverTaskId: this.resolverTaskId,
          dataset: this.dataset,
          filename,
          type: this.classifyFileType(filename),
          data,
        }),
      });
      if (!resp.ok) {
        console.warn(`[ServerUpload] ${filename} upload failed: ${resp.status}`);
      } else {
        console.log(`[ServerUpload] ${filename} uploaded to ${this.resolverTaskId}/${this.dataset}/${this.sessionId}`);
      }
    } catch (err) {
      console.warn(`[ServerUpload] ${filename} upload error: ${err}`);
    }
  }

  async saveAccumulatedSnapshots(): Promise<SnapshotSaveResult> {
    const snapshots = getAccumulatedSnapshots();
    console.log(`[ServerUpload] saveAccumulatedSnapshots: ${snapshots.length} snapshots (types: ${snapshots.map(s => s.type || s.filename).join(', ')})`);
    if (snapshots.length === 0) {
      return { saved: 0, failed: 0, savedFilenames: [] };
    }

    const tasks = snapshots.map((s) => ({
      filename: generateSnapshotFilename(s),
      snapshot: s,
    }));

    const savedFilenames: string[] = [];
    let saved = 0;
    let failed = 0;

    // Upload in parallel with concurrency limit
    const CONCURRENCY = 5;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(({ filename, snapshot }) =>
          this.saveFile(filename, snapshot.data, snapshot.mimeType)
            .then(() => ({ filename, ok: true as const })),
        ),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value.ok) {
          saved++;
          savedFilenames.push(r.value.filename);
        } else {
          failed++;
          console.error(`[ServerUpload] Failed to upload ${batch[j].filename}: ${r.status === 'rejected' ? r.reason : 'unknown'}`);
        }
      }
    }

    console.log(`[ServerUpload] Uploaded ${saved} snapshots, ${failed} failed`);
    clearAccumulatedSnapshots();
    return { saved, failed, savedFilenames };
  }

  async saveTaskStatus(taskStatus: Record<string, unknown>): Promise<void> {
    await this.saveFile('task_status.json', jsonToBase64(taskStatus), 'application/json');
  }

  // Protocol signals are only used by the resolver client loop (local mode).
  // In server mode these are no-ops.
  async writeDoneSignal(_result: DoneSignalPayload): Promise<void> { /* no-op */ }
  async writeAgentDoneSignal(_status: string): Promise<void> { /* no-op */ }
  async writePrepareDoneSignal(): Promise<void> { /* no-op */ }

  private classifyFileType(filename: string): string {
    if (filename === 'task_status.json') return 'task_status';
    if (filename === 'progress.json') return 'progress';
    if (filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'screenshot';
    if (filename.endsWith('.pseudo.dom')) return 'pseudo_dom';
    if (filename.endsWith('.html')) return 'full_dom';
    return 'other';
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the appropriate saver based on execution context.
 *
 * @param localOutputDir  - If set, use local saver (resolver client loop mode)
 * @param serverUrl       - Server URL for upload mode
 * @param sessionId       - Task ID / query hash
 * @param resolverTaskId  - Resolver task ID (e.g., 'quick_trial')
 * @param dataset         - Dataset name (e.g., 'custom')
 * @returns saver instance, or null if debug mode is off and no localOutputDir
 */
export function createSnapshotSaver(
  localOutputDir: string | null | undefined,
  serverUrl: string,
  sessionId: string,
  resolverTaskId: string,
  dataset: string,
  debugModeEnabled: boolean,
): ISnapshotSaver | null {
  if (localOutputDir) {
    return new LocalSnapshotSaver(localOutputDir);
  }
  // Quick trial mode: only upload to server when debug mode is enabled
  if (debugModeEnabled) {
    return new ServerSnapshotSaver(serverUrl, sessionId, resolverTaskId, dataset);
  }
  return null;
}
