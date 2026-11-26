import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type StateNamespace =
  | 'jobs'
  | 'mandates'
  | 'approvals'
  | 'plugin_tokens'
  | 'gasless_intents'
  | 'preservation_agents'
  | (string & {});

export interface SiphonStateStore {
  readonly kind: 'memory' | 'file' | string;
  readonly persistent: boolean;
  load<T>(namespace: StateNamespace, fallback: T): T;
  save<T>(namespace: StateNamespace, data: T): void;
  delete(namespace: StateNamespace): void;
  listNamespaces(): string[];
  clear(): void;
}

interface PersistedEnvelope<T> {
  version: 1;
  updatedAt: string;
  data: T;
}

const VALID_NAMESPACE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertValidNamespace(namespace: string): string {
  const clean = typeof namespace === 'string' ? namespace.trim() : '';
  if (!VALID_NAMESPACE_RE.test(clean)) {
    throw new Error(
      `Invalid state store namespace "${String(namespace)}": expected 1-64 alphanumeric, underscore, or hyphen characters.`
    );
  }
  return clean;
}

/**
 * In-memory state store used by default in tests and ephemeral runs when
 * SIPHON_DATA_DIR is unset. Serializes through JSON to preserve persistence semantics.
 */
export class MemoryStateStore implements SiphonStateStore {
  readonly kind = 'memory' as const;
  readonly persistent = false;
  private readonly entries = new Map<string, string>();

  load<T>(namespace: StateNamespace, fallback: T): T {
    const key = assertValidNamespace(namespace);
    const raw = this.entries.get(key);
    if (raw === undefined) return fallback;
    try {
      const parsed = JSON.parse(raw) as PersistedEnvelope<T>;
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        return parsed.data;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  save<T>(namespace: StateNamespace, data: T): void {
    const key = assertValidNamespace(namespace);
    const envelope: PersistedEnvelope<T> = {
      version: 1,
      updatedAt: new Date().toISOString(),
      data,
    };
    this.entries.set(key, JSON.stringify(envelope));
  }

  delete(namespace: StateNamespace): void {
    const key = assertValidNamespace(namespace);
    this.entries.delete(key);
  }

  listNamespaces(): string[] {
    return Array.from(this.entries.keys()).sort();
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface FileStateStoreOptions {
  dataDir: string;
  fileMode?: number;
  dirMode?: number;
}

/**
 * Zero-dependency atomic file-backed JSON state store.
 * Writes each namespace to a unique temp file in `dataDir` with restrictive permissions
 * and atomically swaps it into place via `fs.renameSync`.
 */
export class FileStateStore implements SiphonStateStore {
  readonly kind = 'file' as const;
  readonly persistent = true;
  readonly dataDir: string;
  private readonly fileMode: number;
  private readonly dirMode: number;

  constructor(dirOrOpts: string | FileStateStoreOptions) {
    const opts = typeof dirOrOpts === 'string' ? { dataDir: dirOrOpts } : dirOrOpts;
    const trimmed = opts.dataDir?.trim();
    if (!trimmed) {
      throw new Error('FileStateStore requires a non-empty dataDir path.');
    }
    this.dataDir = path.resolve(trimmed);
    this.fileMode = opts.fileMode ?? 0o600;
    this.dirMode = opts.dirMode ?? 0o700;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: this.dirMode });
    }
  }

  private resolveNamespacePath(namespace: StateNamespace): string {
    const clean = assertValidNamespace(namespace);
    const target = path.resolve(this.dataDir, `${clean}.json`);
    if (!target.startsWith(this.dataDir + path.sep)) {
      throw new Error(`State store path escape rejected for namespace "${clean}".`);
    }
    return target;
  }

  load<T>(namespace: StateNamespace, fallback: T): T {
    const filePath = this.resolveNamespacePath(namespace);
    if (!fs.existsSync(filePath)) return fallback;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return fallback;
      const parsed = JSON.parse(raw) as PersistedEnvelope<T> | T;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'version' in (parsed as Record<string, unknown>) &&
        'data' in (parsed as Record<string, unknown>)
      ) {
        return (parsed as PersistedEnvelope<T>).data;
      }
      return parsed as T;
    } catch (err) {
      const ts = Date.now();
      const quarantinePath = `${filePath}.corrupt.${ts}`;
      let quarantinedAs: string | null = null;
      try {
        if (fs.existsSync(filePath)) {
          fs.renameSync(filePath, quarantinePath);
          quarantinedAs = path.basename(quarantinePath);
        }
      } catch {
        // best-effort quarantine
      }
      console.warn(
        JSON.stringify({
          ts: new Date(ts).toISOString(),
          level: 'warn',
          service: 'siphon-migrator',
          event: 'state_store_corrupt_file_quarantined',
          namespace,
          file: path.basename(filePath),
          quarantinedAs,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return fallback;
    }
  }

  save<T>(namespace: StateNamespace, data: T): void {
    this.ensureDir();
    const clean = assertValidNamespace(namespace);
    const targetPath = this.resolveNamespacePath(clean);
    const tmpName = `.${clean}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tmpPath = path.join(this.dataDir, tmpName);

    const envelope: PersistedEnvelope<T> = {
      version: 1,
      updatedAt: new Date().toISOString(),
      data,
    };
    const serialized = JSON.stringify(envelope, null, 2);

    try {
      fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: this.fileMode });
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // best-effort temp cleanup
      }
      throw err;
    }
  }

  delete(namespace: StateNamespace): void {
    const filePath = this.resolveNamespacePath(namespace);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  listNamespaces(): string[] {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs
      .readdirSync(this.dataDir)
      .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((name) => VALID_NAMESPACE_RE.test(name))
      .sort();
  }

  clear(): void {
    for (const ns of this.listNamespaces()) {
      this.delete(ns);
    }
  }
}

export interface CreateStateStoreOptions {
  stateStore?: SiphonStateStore;
  dataDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the active SiphonStateStore:
 *   1. Explicit `stateStore` instance (allows custom DB/Redis/File adapters)
 *   2. Explicit `dataDir` option or `SIPHON_DATA_DIR` environment variable -> `FileStateStore`
 *   3. Default -> `MemoryStateStore` (safe, zero-disk-footprint default for tests)
 */
export function createStateStore(opts: CreateStateStoreOptions = {}): SiphonStateStore {
  if (opts.stateStore) return opts.stateStore;

  const env = opts.env ?? process.env;
  const resolvedDir =
    opts.dataDir !== undefined
      ? opts.dataDir?.trim() || null
      : env.SIPHON_DATA_DIR?.trim() || null;

  if (resolvedDir) {
    return new FileStateStore(resolvedDir);
  }
  return new MemoryStateStore();
}
