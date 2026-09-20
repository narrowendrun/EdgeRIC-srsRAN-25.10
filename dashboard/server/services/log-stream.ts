import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { Request, Response } from 'express'
import { allowedWindows, managedUnits, type ModuleName, type WindowSize } from '../config.js'
import { run, stripAnsi } from '../utils.js'

function linesFromFile(file: string, limit: number, prefix?: string) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit)
      .map((line) => prefix ? `[${prefix}] ${line}` : line)
  } catch {
    return []
  }
}

export async function historicalLogs(module: ModuleName, window: WindowSize) {
  const selection = allowedWindows[window]
  if (module === 'open5gs') {
    const perFile = Math.max(100, Math.floor(selection.lineLimit / 3))
    return [
      ...linesFromFile('/var/log/open5gs/amf.log', perFile, 'AMF'),
      ...linesFromFile('/var/log/open5gs/smf.log', perFile, 'SMF'),
      ...linesFromFile('/var/log/open5gs/upf.log', perFile, 'UPF'),
    ].slice(-selection.lineLimit)
  }

  const journal = await run('/usr/bin/journalctl', [
    '-u', managedUnits[module], '--since', selection.since, '--no-pager', '-o', 'short-iso', '-n', String(selection.lineLimit),
  ], 8000)
  const lines = journal.stdout.split(/\r?\n/).filter(Boolean).map(stripAnsi)
  if (lines.length > 0 && !lines.every((line) => line.includes('-- No entries --'))) return lines
  return module === 'gnb' ? linesFromFile('/tmp/gnb.log', selection.lineLimit) : []
}

function sendSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function streamLogs(req: Request, res: Response, module: ModuleName, window: WindowSize) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sendSse(res, 'backfill', { lines: await historicalLogs(module, window) })

  const children: ReturnType<typeof spawn>[] = []
  const attach = (child: ReturnType<typeof spawn>, prefix?: string) => {
    children.push(child)
    let pending = ''
    child.stdout?.on('data', (chunk) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines.filter(Boolean)) {
        const clean = stripAnsi(line)
        sendSse(res, 'line', { line: prefix ? `[${prefix}] ${clean}` : clean })
      }
    })
    child.stderr?.on('data', (chunk) => sendSse(res, 'notice', { line: chunk.toString().trim() }))
  }

  if (module === 'open5gs') {
    attach(spawn('/usr/bin/tail', ['-n', '0', '-F', '/var/log/open5gs/amf.log']), 'AMF')
    attach(spawn('/usr/bin/tail', ['-n', '0', '-F', '/var/log/open5gs/smf.log']), 'SMF')
    attach(spawn('/usr/bin/tail', ['-n', '0', '-F', '/var/log/open5gs/upf.log']), 'UPF')
  } else {
    attach(spawn('/usr/bin/journalctl', ['-u', managedUnits[module], '-f', '-n', '0', '-o', 'short-iso']))
  }

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    for (const child of children) child.kill('SIGTERM')
  })
}
