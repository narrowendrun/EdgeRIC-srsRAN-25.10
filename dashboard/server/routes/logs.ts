import { Router } from 'express'
import { allowedWindows, type ModuleName, type WindowSize } from '../config.js'
import { historicalLogs, streamLogs } from '../services/log-stream.js'

export const logsRouter = Router()

logsRouter.get('/logs/:module', async (req, res) => {
  const module = req.params.module as ModuleName
  const window = String(req.query.window || '5m') as WindowSize
  if (!['open5gs', 'edgeric', 'gnb'].includes(module) || !(window in allowedWindows)) {
    return res.status(400).json({ error: 'Unsupported log source or time window.' })
  }
  res.json({ lines: await historicalLogs(module, window) })
})

logsRouter.get('/logs/:module/stream', async (req, res) => {
  const module = req.params.module as ModuleName
  const window = String(req.query.window || '5m') as WindowSize
  if (!['open5gs', 'edgeric', 'gnb'].includes(module) || !(window in allowedWindows)) return res.status(400).end()
  await streamLogs(req, res, module, window)
})
