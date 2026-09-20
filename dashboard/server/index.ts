import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import express from 'express'
import httpProxy from 'http-proxy'
import { dashboardRoot, host, logsRoot, port, webuiProxyPort } from './config.js'
import { controlRouter } from './routes/control.js'
import { logsRouter } from './routes/logs.js'
import { metricsRouter } from './routes/metrics.js'
import { runsRouter } from './routes/runs.js'
import { statusRouter } from './routes/status.js'
import { RunStore } from './services/run-store.js'

const app = express()
const runStore = new RunStore(logsRoot)
runStore.resumeCapture()

app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))
app.use('/api', statusRouter, controlRouter(runStore), logsRouter, metricsRouter(runStore), runsRouter(runStore))

const staticRoot = path.join(dashboardRoot, 'dist')
if (existsSync(staticRoot)) {
  app.use(express.static(staticRoot, {
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache')
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(staticRoot, 'index.html'))
  })
}

const server = createServer(app)
server.listen(port, host, () => console.log(`EdgeRIC dashboard listening on http://${host}:${port}`))

const webuiProxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:9999', changeOrigin: true, ws: true })
webuiProxy.on('error', (_error, _req, res) => {
  if ('writeHead' in res) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Open5GS WebUI is unavailable.')
  }
})
const proxyServer = createServer((req, res) => webuiProxy.web(req, res))
proxyServer.on('upgrade', (req, socket, head) => webuiProxy.ws(req, socket, head))
proxyServer.listen(webuiProxyPort, host, () => console.log(`Open5GS WebUI proxy listening on http://${host}:${webuiProxyPort}`))

function shutdown() {
  runStore.shutdown()
  proxyServer.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
