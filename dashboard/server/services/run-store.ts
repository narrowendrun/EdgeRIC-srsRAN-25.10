import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync, type WriteStream,
} from 'node:fs'
import path from 'node:path'
import { managedUnits, open5gsLogNames, projectRoot, recorderUnit } from '../config.js'
import { run } from '../utils.js'

export interface RunManifest {
  schemaVersion: 1
  id: string
  startedAt: string
  endedAt: string | null
  status: 'active' | 'completed' | 'interrupted'
  gitCommit: string
  configFile: string
  observedRntis: string[]
  metrics: { messages: number; ueSamples: number; missedTtis: number }
  /**
   * When the metric counters below were successfully derived from the run's database.
   * null means "never computed" (not "computed and genuinely zero"), which is what lets
   * list() repair a run whose stats read lost a race with the recorder shutting down.
   */
  statsComputedAt: string | null
}

interface Capture { child: ChildProcessWithoutNullStreams; stream: WriteStream }

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function unitIsActive(unit: string) {
  // `systemctl is-active` exits 3 when inactive, so read stdout rather than the exit code.
  const result = await run('/usr/bin/systemctl', ['is-active', unit])
  return (result.stdout || 'inactive') === 'active'
}

export class RunStore {
  readonly runsRoot: string
  readonly activeFile: string
  /** Set by the control route while a start/stop/restart is in flight, so reconcile() stands down. */
  busy = false
  private captures: Capture[] = []
  private repairAttempted = new Set<string>()
  private idleChecks = 0
  private reconciling = false

  constructor(logsRoot: string) {
    this.runsRoot = path.join(logsRoot, 'runs')
    this.activeFile = path.join(logsRoot, 'active-run.json')
    mkdirSync(this.runsRoot, { recursive: true })
  }

  activeId() {
    try {
      const value = JSON.parse(readFileSync(this.activeFile, 'utf8')) as { runId?: string }
      return value.runId && this.validId(value.runId) ? value.runId : null
    } catch {
      return null
    }
  }

  runDir(id: string) {
    if (!this.validId(id)) throw new Error('Invalid run identifier')
    return path.join(this.runsRoot, id)
  }

  async ensureActive() {
    const current = this.activeId()
    if (current) {
      if (this.captures.length === 0) this.startCapture(current)
      return current
    }

    const now = new Date()
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const id = `${stamp}${randomBytes(2).toString('hex').toUpperCase()}`
    const dir = this.runDir(id)
    mkdirSync(path.join(dir, 'open5gs'), { recursive: true })
    mkdirSync(path.join(dir, 'config'), { recursive: true })
    const configName = 'gnb_rf_x310_tdd_n78_20mhz.yml'
    const sourceConfig = path.join(projectRoot, configName)
    if (existsSync(sourceConfig)) copyFileSync(sourceConfig, path.join(dir, 'config', configName))
    const git = await run('/usr/bin/git', ['-C', projectRoot, 'rev-parse', '--short', 'HEAD'])
    const manifest: RunManifest = {
      schemaVersion: 1, id, startedAt: now.toISOString(), endedAt: null, status: 'active',
      gitCommit: git.ok ? git.stdout : 'unknown', configFile: configName,
      observedRntis: [], metrics: { messages: 0, ueSamples: 0, missedTtis: 0 },
      statsComputedAt: null,
    }
    this.writeManifest(manifest)
    writeFileSync(this.activeFile, `${JSON.stringify({ runId: id, runDir: dir, startedAt: manifest.startedAt }, null, 2)}\n`, { mode: 0o644 })
    this.startCapture(id)
    return id
  }

  resumeCapture() {
    const id = this.activeId()
    if (id) this.startCapture(id)
  }

  async finalize(status: 'completed' | 'interrupted' = 'completed') {
    const id = this.activeId()
    if (!id) return null
    this.stopCapture()
    // The recorder is PartOf the collector, so systemd stops it as a propagated job that can
    // still be running -- and holding an exclusive lock for its WAL checkpoint -- after
    // `systemctl stop edgeric-collector` returns. Reading its database before it lets go is
    // what silently produced zeroed manifests.
    if (!await this.waitForRecorderStop()) {
      console.warn(`Recorder still active after timeout while finalizing ${id}; stats may be incomplete.`)
    }
    const manifest = this.readManifest(id)
    if (!manifest) return null
    const stats = await this.readMetricsStats(id)
    manifest.status = status
    manifest.endedAt = new Date().toISOString()
    if (stats) {
      manifest.metrics = stats.metrics
      manifest.observedRntis = stats.rntis
      manifest.statsComputedAt = new Date().toISOString()
    }
    this.writeManifest(manifest)
    rmSync(this.activeFile, { force: true })
    return id
  }

  /**
   * Closes a run that ended outside the dashboard -- a gNB crash, or `systemctl stop` from a
   * shell. Without this, active-run.json survives and the next experiment's metrics land in the
   * previous run's database.
   */
  async reconcile() {
    if (this.busy || this.reconciling) { this.idleChecks = 0; return }
    if (!this.activeId()) { this.idleChecks = 0; return }
    this.reconciling = true
    try {
      const units = [managedUnits.gnb, managedUnits.edgeric, recorderUnit]
      const active = await Promise.all(units.map(unitIsActive))
      if (active.some(Boolean)) { this.idleChecks = 0; return }
      // Three consecutive idle checks (~15s) so restarting one module is not mistaken for the
      // end of a run.
      if (++this.idleChecks < 3) return
      this.idleChecks = 0
      console.warn('Stack stopped outside the dashboard; finalizing run as interrupted.')
      await this.finalize('interrupted')
    } finally {
      this.reconciling = false
    }
  }

  async list() {
    const manifests = readdirSync(this.runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && this.validId(entry.name))
      .map((entry) => this.readManifest(entry.name))
      .filter((item): item is RunManifest => Boolean(item))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    for (const manifest of manifests) {
      if (manifest.status === 'active' || manifest.statsComputedAt) continue
      // Claim before awaiting so concurrent /api/runs requests cannot both spawn the reader.
      if (this.repairAttempted.has(manifest.id)) continue
      this.repairAttempted.add(manifest.id)
      const stats = await this.readMetricsStats(manifest.id)
      if (!stats) continue
      manifest.metrics = stats.metrics
      manifest.observedRntis = stats.rntis
      manifest.statsComputedAt = new Date().toISOString()
      this.writeManifest(manifest)
      console.log(`Repaired metric stats for ${manifest.id}: ${stats.metrics.messages} messages.`)
    }

    return manifests.map((manifest) => {
      const dbPath = path.join(this.runDir(manifest.id), 'metrics.sqlite3')
      return { ...manifest, databaseBytes: existsSync(dbPath) ? statSync(dbPath).size : 0 }
    })
  }

  readManifest(id: string) {
    try {
      return JSON.parse(readFileSync(path.join(this.runDir(id), 'manifest.json'), 'utf8')) as RunManifest
    } catch {
      return null
    }
  }

  logFiles(id: string) {
    const dir = this.runDir(id)
    const result: string[] = []
    for (const name of ['gnb.log', 'edgeric.log']) if (existsSync(path.join(dir, name))) result.push(name)
    const open5gsDir = path.join(dir, 'open5gs')
    if (existsSync(open5gsDir)) {
      for (const entry of readdirSync(open5gsDir).sort()) if (entry.endsWith('.log')) result.push(`open5gs/${entry}`)
    }
    return result
  }

  resolveLog(id: string, relative: string) {
    if (!/^(gnb|edgeric)\.log$|^open5gs\/[a-z0-9_-]+\.log$/.test(relative)) return null
    const resolved = path.resolve(this.runDir(id), relative)
    return resolved.startsWith(`${this.runDir(id)}${path.sep}`) && existsSync(resolved) ? resolved : null
  }

  shutdown() {
    this.stopCapture()
  }

  private validId(id: string) {
    return /^[0-9]{8}T[0-9]{6}Z[0-9A-F]{4}$/.test(id)
  }

  private writeManifest(manifest: RunManifest) {
    writeFileSync(path.join(this.runDir(manifest.id), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async waitForRecorderStop(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!await unitIsActive(recorderUnit)) return true
      await delay(250)
    }
    return false
  }

  private attach(command: string, args: string[], destination: string) {
    const stream = createWriteStream(destination, { flags: 'a' })
    // An unhandled 'error' event throws and takes the process down. ENOSPC is the realistic
    // trigger here, since run capture has no retention policy.
    stream.on('error', (error) => console.error(`Log capture write failed (${destination}):`, error))
    const child = spawn(command, args)
    child.on('error', (error) => console.error(`Log capture spawn failed (${command}):`, error))
    child.stdout.pipe(stream, { end: false })
    child.stderr.on('data', (chunk) => {
      if (!stream.writableEnded) stream.write(`[capture] ${chunk.toString()}`)
    })
    this.captures.push({ child, stream })
  }

  private startCapture(id: string) {
    if (this.captures.length > 0) return
    const dir = this.runDir(id)
    this.attach('/usr/bin/journalctl', ['-u', managedUnits.gnb, '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'gnb.log'))
    // Recorder only, not the collector: the collector prints per-TTI, which produced a 116 MB
    // edgeric.log for a 14-minute run -- duplicating, unstructured, what metrics.sqlite3 already
    // holds. The live terminal's EdgeRIC tab still streams the collector straight from journald,
    // so this costs nothing but archive bloat.
    this.attach('/usr/bin/journalctl', ['-u', recorderUnit, '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'edgeric.log'))
    for (const name of open5gsLogNames) {
      const source = `/var/log/open5gs/${name}.log`
      if (existsSync(source)) this.attach('/usr/bin/tail', ['-n', '0', '-F', source], path.join(dir, 'open5gs', `${name}.log`))
    }
    this.attach('/usr/bin/journalctl', ['-u', 'open5gs-webui.service', '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'open5gs', 'webui.log'))
  }

  private stopCapture() {
    for (const { child, stream } of this.captures) {
      // End the stream only once the child is gone, so a late stderr chunk cannot write
      // after end.
      child.once('close', () => stream.end())
      child.kill('SIGTERM')
    }
    this.captures = []
  }

  private async readMetricsStats(id: string) {
    const db = path.join(this.runDir(id), 'metrics.sqlite3')
    if (!existsSync(db)) return null
    const script = path.join(projectRoot, 'dashboard', 'server', 'scripts', 'metrics_stats.py')
    const result = await run(path.join(projectRoot, '.venv', 'bin', 'python'), [script, db], 30_000)
    if (!result.ok) {
      console.error(`Metric stats read failed for ${id}: ${result.stderr || 'unknown error'}`)
      return null
    }
    try {
      return JSON.parse(result.stdout) as { metrics: RunManifest['metrics']; rntis: string[] }
    } catch (error) {
      console.error(`Metric stats output was not valid JSON for ${id}:`, error)
      return null
    }
  }
}
