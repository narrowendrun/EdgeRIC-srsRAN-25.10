import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync, type WriteStream,
} from 'node:fs'
import path from 'node:path'
import { open5gsLogNames, projectRoot } from '../config.js'
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
}

interface Capture { child: ChildProcessWithoutNullStreams; stream: WriteStream }

export class RunStore {
  readonly runsRoot: string
  readonly activeFile: string
  private captures: Capture[] = []

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
    const manifest = this.readManifest(id)
    if (!manifest) return null
    const stats = await this.readMetricsStats(id)
    manifest.status = status
    manifest.endedAt = new Date().toISOString()
    if (stats) {
      manifest.metrics = stats.metrics
      manifest.observedRntis = stats.rntis
    }
    this.writeManifest(manifest)
    rmSync(this.activeFile, { force: true })
    return id
  }

  list() {
    const runs = readdirSync(this.runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && this.validId(entry.name))
      .map((entry) => this.readManifest(entry.name))
      .filter((item): item is RunManifest => Boolean(item))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return runs.map((manifest) => {
      const dir = this.runDir(manifest.id)
      const dbPath = path.join(dir, 'metrics.sqlite3')
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

  private attach(command: string, args: string[], destination: string) {
    const stream = createWriteStream(destination, { flags: 'a' })
    const child = spawn(command, args)
    child.stdout.pipe(stream, { end: false })
    child.stderr.on('data', (chunk) => stream.write(`[capture] ${chunk.toString()}`))
    this.captures.push({ child, stream })
  }

  private startCapture(id: string) {
    if (this.captures.length > 0) return
    const dir = this.runDir(id)
    this.attach('/usr/bin/journalctl', ['-u', 'edgeric-gnb.service', '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'gnb.log'))
    this.attach('/usr/bin/journalctl', ['-u', 'edgeric-collector.service', '-u', 'edgeric-metrics-recorder.service', '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'edgeric.log'))
    for (const name of open5gsLogNames) {
      const source = `/var/log/open5gs/${name}.log`
      if (existsSync(source)) this.attach('/usr/bin/tail', ['-n', '0', '-F', source], path.join(dir, 'open5gs', `${name}.log`))
    }
    this.attach('/usr/bin/journalctl', ['-u', 'open5gs-webui.service', '-f', '-n', '0', '-o', 'short-iso'], path.join(dir, 'open5gs', 'webui.log'))
  }

  private stopCapture() {
    for (const { child } of this.captures) child.kill('SIGTERM')
    for (const { stream } of this.captures) stream.end()
    this.captures = []
  }

  private async readMetricsStats(id: string) {
    const db = path.join(this.runDir(id), 'metrics.sqlite3')
    if (!existsSync(db)) return null
    const script = path.join(projectRoot, 'dashboard', 'server', 'scripts', 'metrics_stats.py')
    const result = await run(path.join(projectRoot, '.venv', 'bin', 'python'), [script, db], 5000)
    if (!result.ok) return null
    try {
      return JSON.parse(result.stdout) as { metrics: RunManifest['metrics']; rntis: string[] }
    } catch {
      return null
    }
  }
}
