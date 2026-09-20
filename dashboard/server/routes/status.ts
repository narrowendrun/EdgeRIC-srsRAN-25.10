import { Router } from 'express'
import { getStatus } from '../services/systemd.js'

export const statusRouter = Router()
statusRouter.get('/health', (_req, res) => res.json({ ok: true }))
statusRouter.get('/status', async (_req, res) => res.json(await getStatus()))
