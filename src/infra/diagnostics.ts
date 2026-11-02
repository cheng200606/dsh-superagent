/**
 * The plugin's own record of what it did, kept next to its database.
 *
 * DSH runs as its own process, so its log lines do not reach the terminal that started it, and a
 * diagnosis that depends on them is no diagnosis at all. This writes a bounded, append-only log that
 * `local/scripts/diagnose.mjs` can read: one JSON object per line, oldest first.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The log keeps the most recent lines; older ones are dropped when it grows past this many. */
const MAX_BYTES = 512 * 1024
const MAX_LINES = 2000

export interface DiagnosticEvent {
  /** What happened, such as `start`, `setup` or `http-error`. */
  event: string
  /** When it happened. */
  at?: string
  /** Anything that explains it; never a credential. */
  detail?: Record<string, unknown>
}

/** Writes the plugin's lifecycle to a file under the state directory. */
export class Diagnostics {
  private readonly path: string
  private queued: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  /** The file the log is written to. */
  get file(): string {
    return this.path
  }

  /**
   * Records one event. Writing is serialized and never rejects: a diagnosis that fails to write must
   * not stop the service, and a lost line is better than a crashed request.
   */
  record(event: string, detail?: Record<string, unknown>): void {
    const entry: DiagnosticEvent = { event, at: new Date().toISOString(), ...detail ? { detail } : {} }
    this.queued = this.queued.then(() => this.append(JSON.stringify(entry))).catch(() => { /* The log is best effort. */ })
  }

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, `${line}\n`, 'utf8')
    await this.trim()
  }

  /** Keeps the log bounded: it drops the oldest lines once it grows past its limits. */
  private async trim(): Promise<void> {
    let size = -1
    try { size = (await stat(this.path)).size } catch { return }
    if (size <= MAX_BYTES) return
    const lines = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean)
    const kept = lines.slice(-MAX_LINES)
    await writeFile(this.path, kept.join('\n') + '\n', 'utf8')
  }

  /** The most recent events, oldest first; the last `count` of them. */
  async recent(count = 50): Promise<DiagnosticEvent[]> {
    let text = ''
    try { text = await readFile(this.path, 'utf8') } catch { return [] }
    const lines = text.split('\n').filter(Boolean).slice(-count)
    const events: DiagnosticEvent[] = []
    for (const line of lines) {
      try { events.push(JSON.parse(line) as DiagnosticEvent) } catch { /* A torn line is skipped. */ }
    }
    return events
  }
}
