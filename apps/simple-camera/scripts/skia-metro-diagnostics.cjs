// Temporary fork-only observations and an opt-in cold-bundle experiment.
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

async function initializeMetro(context) {
  hook(context)
  if (process.env.HARNESS_SKIA_PREWARM !== '1') return

  // Match Harness 1.4's fetchModule URL and consume the entire response.
  // Its normal entry prewarm does not prepare this separate test bundle.
  const url = new URL(
    '/__tests__/visioncamera.skia-camera.harness.bundle',
    `http://${context.host || '127.0.0.1'}:${context.port}`,
  )
  url.search = new URLSearchParams({ modulesOnly: 'true', platform: 'ios' })
  const started = Date.now()
  log('prewarm:started', { pathname: url.pathname })
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([
        context.abortSignal,
        AbortSignal.timeout(300_000),
      ]),
    })
    log('prewarm:headers', {
      status: response.status,
      elapsedMs: Date.now() - started,
    })
    let bytes = 0
    for await (const chunk of response.body) bytes += chunk.byteLength
    if (!response.ok) throw new Error(`Skia prewarm HTTP ${response.status}`)
    log('prewarm:finished', { bytes, elapsedMs: Date.now() - started })
  } catch (error) {
    log('prewarm:failed', {
      error: String(error),
      elapsedMs: Date.now() - started,
    })
    throw error
  }
}

exports.plugin = {
  name: 'skia-ci-diagnostics',
  hooks: {
    runtime: {
      ready: hook,
      disconnected: (context) =>
        log(context.meta.hook, { reason: context.reason }),
    },
    app: {
      started: appHook,
      exited: appHook,
      possibleCrash: appHook,
    },
    metro: {
      initialized: initializeMetro,
      bundleStarted: hook,
      bundleFinished: hook,
      bundleFailed: hook,
      clientLog: ({ level, data }) => log('client-log', { level, data }),
    },
    collection: { started: hook, finished: hook },
    test: { started: hook, finished: hook },
  },
}

function appHook(context) {
  const { pid, source, line, isConfirmed, crashDetails } = context
  log(context.meta.hook, {
    appPid: pid,
    source,
    line,
    isConfirmed,
    crashDetails,
  })
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
