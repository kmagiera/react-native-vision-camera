// Temporary fork-only observations: no request, bundle or test behavior changes.
const { appendFileSync } = require('node:fs')
const path = require('node:path')

function log(stage, details = {}) {
  const directory = process.env.HARNESS_SKIA_DIAGNOSTICS_DIR
  if (!directory) return
  appendFileSync(
    path.join(directory, 'metro-events.ndjson'),
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, stage, ...details })}\n`,
  )
}

function hook(context) {
  // Do not serialize the full context: it includes configuration and handles.
  const { file, target, duration, totalTests, name, status, error } = context
  log(context.meta.hook, {
    file,
    target,
    duration,
    totalTests,
    name,
    status,
    error,
  })
}

exports.plugin = {
  name: 'skia-ci-diagnostics',
  hooks: {
    runtime: { ready: hook, disconnected: hook },
    metro: {
      initialized: hook,
      bundleStarted: hook,
      bundleFinished: hook,
      bundleFailed: hook,
      clientLog: ({ level, data }) => log('client-log', { level, data }),
    },
    collection: { started: hook, finished: hook },
    test: { started: hook, finished: hook },
  },
}

exports.enhanceMiddleware = (middleware) => {
  log('middleware:initialized')
  let previousTick = Date.now()
  let previousCPU = process.cpuUsage()
  setInterval(() => {
    const now = Date.now()
    const cpu = process.cpuUsage()
    log('metro:health', {
      elapsedMs: now - previousTick,
      cpuUserMicros: cpu.user - previousCPU.user,
      cpuSystemMicros: cpu.system - previousCPU.system,
      memory: process.memoryUsage(),
    })
    previousTick = now
    previousCPU = cpu
  }, 30_000).unref()

  let requestId = 0
  return (request, response, next) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname.endsWith('.bundle') || pathname === '/status') {
      const id = ++requestId
      const started = Date.now()
      log('http:request', { id, pathname, method: request.method })
      response.once('finish', () =>
        log('http:finish', {
          id,
          pathname,
          status: response.statusCode,
          elapsedMs: Date.now() - started,
        }),
      )
      response.once('close', () =>
        log('http:close', {
          id,
          pathname,
          finished: response.writableFinished,
          elapsedMs: Date.now() - started,
        }),
      )
    }
    return middleware(request, response, next)
  }
}
