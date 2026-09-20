import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Request } from 'express'

const execFileAsync = promisify(execFile)

export async function run(command: string, args: string[], timeout = 5000) {
  try {
    const result = await execFileAsync(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: String(failure.stdout || '').trim(),
      stderr: String(failure.stderr || failure.message || '').trim(),
    }
  }
}

export function sameOrigin(req: Request) {
  const origin = req.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === req.get('host')
  } catch {
    return false
  }
}

export function stripAnsi(value: string) {
  return value.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}
