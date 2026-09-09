// Temporary, fork-only diagnostics. Keep the normal Harness runner and build;
// select one test and collect evidence outside its potentially stalled bridge.
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const artifacts = path.resolve('.harness/skia-diagnostics')
await mkdir(artifacts, { recursive: true })
process.env.HARNESS_SKIA_DIAGNOSTICS_DIR = artifacts
const startedAt = Date.now()
const children = new Set()
const captures = new Set()
const timers = new Set()
let udid
let interval
let appPoll
let hostInterval
let hostProbe
let recordingStarted = false
let watchdog
let hardStop
let deadlineExceeded = false
let captureNumber = 0
let exitCode = 1

function trace(stage, details = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    stage,
    ...details,
  })
  appendFileSync(path.join(artifacts, 'host-events.ndjson'), `${line}\n`)
  console.log(`[skia-ci] ${line}`)
}

async function command(file, args, name, timeout = 20_000) {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (name) await writeFile(path.join(artifacts, name), stdout + stderr)
    return stdout
  } catch (error) {
    trace('diagnostic-command-failed', {
      file,
      args,
      error: String(error),
      code: error.code,
      signal: error.signal,
      killed: error.killed,
    })
    if (name)
      await writeFile(
        path.join(artifacts, name),
        `${error.stdout ?? ''}${error.stderr ?? ''}\n${error}`,
      )
    return undefined
  }
}

function startProcess(file, args, name, tee = false) {
  const output = createWriteStream(path.join(artifacts, name))
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  if (tee) {
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  }
  child.once('error', (error) =>
    trace('process-error', { file, error: String(error) }),
  )
  const done = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      children.delete(child)
      output.end()
      trace('process-exit', { file, code, signal })
      resolve(code ?? 1)
    }),
  )
  return { child, done }
}

function capture(label, sample = false) {
  const name = `${String(++captureNumber).padStart(3, '0')}-${label}`
  const pending = (async () => {
    trace('capture', { name, sample })
    const screenshot = command(
      'xcrun',
      ['simctl', 'io', udid, 'screenshot', path.join(artifacts, `${name}.png`)],
      `${name}-screenshot.log`,
    )
    const pids = await command('pgrep', ['-x', 'SimpleCamera'])
    for (const pid of (pids ?? '').trim().split(/\s+/).filter(Boolean)) {
      await command(
        'ps',
        ['-p', pid, '-o', 'pid,ppid,%cpu,%mem,etime,command'],
        `${name}-${pid}-process.txt`,
      )
      if (sample)
        await command(
          '/usr/bin/sample',
          [
            pid,
            '2',
            '-mayDie',
            '-file',
            path.join(artifacts, `${name}-${pid}-stacks.txt`),
          ],
          `${name}-${pid}-sample.log`,
          60_000,
        )
    }
    await screenshot
  })().catch((error) => trace('capture-error', { error: String(error) }))
  captures.add(pending)
  pending.finally(() => captures.delete(pending))
  return pending
}

// Independent localhost endpoint keeps phase markers even if Harness never
// receives the test result. The collector is restricted to this CI host.
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/phase') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
    if (body.length > 65_536) request.destroy()
  })
  request.on('end', () => {
    try {
      const event = JSON.parse(body)
      trace('app-event', { event })
      if (event.stage === 'test:begin' && watchdog != null && !deadlineExceeded)
        armDeadline('test', 10 * 60_000)
      if (
        event.stage === 'test:begin' &&
        watchdog != null &&
        !deadlineExceeded &&
        !recordingStarted
      ) {
        recordingStarted = true
        startTestRecording()
      }
      if (
        event.stage === 'render:begin' &&
        watchdog != null &&
        !deadlineExceeded
      ) {
        const timer = setTimeout(() => {
          void capture('render-plus-5s', true)
        }, 5000)
        timers.add(timer)
      }
      response.writeHead(204).end()
    } catch {
      response.writeHead(400).end()
    }
  })
})

function stopChildren() {
  for (const child of children) child.kill('SIGINT')
}

function armDeadline(phase, timeout) {
  clearTimeout(watchdog)
  trace('deadline:armed', { phase, timeout })
  watchdog = setTimeout(() => {
    deadlineExceeded = true
    trace('diagnostic-deadline', { phase })
    clearInterval(hostInterval)
    clearInterval(interval)
    clearInterval(appPoll)
    appPoll = undefined
    stopChildren()
    hardStop = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL')
    }, 10_000)
  }, timeout)
}

function startTestRecording() {
  trace('recording:begin')
  const recording = startProcess(
    'xcrun',
    [
      'simctl',
      'io',
      udid,
      'recordVideo',
      '--codec=h264',
      path.join(artifacts, 'screen.mp4'),
    ],
    'screen-recording.log',
  )
  // Recording has its own cap, independent of the preparation/test budgets.
  timers.add(
    setTimeout(() => {
      trace('recording:deadline')
      recording.child.kill('SIGINT')
    }, 10 * 60_000),
  )
  void capture('test-start')
  interval = setInterval(() => {
    if (captures.size === 0) void capture('periodic')
  }, 60_000)
  void command(
    'simcamctl',
    [
      'diagnostics',
      '--device',
      udid,
      '--app',
      process.env.HARNESS_IOS_BUNDLE_ID,
    ],
    'simcam-test-start.json',
  )
}

process.once('SIGTERM', stopChildren)
process.once('SIGINT', stopChildren)

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(18765, '127.0.0.1', resolve)
  })
  const runtimes = JSON.parse(
    await command(
      'xcrun',
      ['simctl', 'list', 'runtimes', '--json'],
      'runtimes.json',
    ),
  )
  const runtime = runtimes.runtimes.find(
    (item) =>
      item.isAvailable &&
      item.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') &&
      item.version === process.env.HARNESS_IOS_SIMULATOR_VERSION,
  )
  if (!runtime) throw new Error('Requested simulator runtime not found')
  const inventory = JSON.parse(
    await command(
      'xcrun',
      ['simctl', 'list', 'devices', 'available', '--json'],
      'devices.json',
    ),
  )
  const device = inventory.devices[runtime.identifier]?.find(
    (item) => item.name === process.env.HARNESS_IOS_SIMULATOR,
  )
  if (!device) throw new Error('Requested simulator device not found')
  udid = device.udid
  trace('simulator-selected', {
    udid,
    name: device.name,
    runtime: runtime.version,
  })
  if (device.state !== 'Booted') await exec('xcrun', ['simctl', 'boot', udid])
  await exec('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeout: 300_000,
  })
  // A prebooted simulator stays alive through Harness teardown, so recording
  // can be finalized and the failure screen captured after Harness exits.
  await command('uname', ['-m'], 'host-architecture.txt')
  await command('xcodebuild', ['-version'], 'xcode-version.txt')
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
    await command(
      '/usr/libexec/PlistBuddy',
      [
        '-c',
        `Print :${key}`,
        path.join(homedir(), 'Applications/SimCam.app/Contents/Info.plist'),
      ],
      `simcam-${key}.txt`,
    )
  await command(
    'file',
    [
      'ios/build/harness/DerivedData/Build/Products/Debug-iphonesimulator/SimpleCamera.app/SimpleCamera',
    ],
    'app-architecture.txt',
  )

  startProcess(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'stream',
      '--level',
      'info',
      '--style',
      'compact',
      '--predicate',
      '(process == "SimpleCamera" AND subsystem != "com.apple.network" AND subsystem != "com.apple.CFNetwork") OR eventMessage CONTAINS[c] "SimCam"',
    ],
    'simulator.log',
  )
  // No screenshots, recording or sampling while XCTest is being prepared.
  appPoll = setInterval(async () => {
    try {
      const { stdout } = await exec('pgrep', ['-x', 'SimpleCamera'], {
        timeout: 10_000,
      })
      if (appPoll === undefined) return
      clearInterval(appPoll)
      appPoll = undefined
      trace('app:detected', { pids: stdout.trim().split(/\s+/) })
    } catch (error) {
      // pgrep exit 1 simply means Harness has not launched the app yet.
      if (error.code !== 1) trace('app-poll-error', { error: String(error) })
    }
  }, 15_000)
  trace('harness:begin')
  armDeadline('preparation', 25 * 60_000)
  let hostSample = 0
  hostInterval = setInterval(() => {
    if (hostProbe) return
    const name = `host-${++hostSample}`
    trace('host:sample', { name })
    hostProbe = Promise.all([
      command(
        'ps',
        ['-A', '-o', 'pid,ppid,%cpu,rss,etime,comm'],
        `${name}-processes.txt`,
      ),
      command('vm_stat', [], `${name}-memory.txt`),
    ]).finally(() => {
      hostProbe = undefined
    })
  }, 30_000)
  const harness = startProcess(
    '../../node_modules/.bin/react-native-harness',
    [
      '--harnessRunner',
      'ios',
      '--no-watchman',
      '--verbose',
      '--forceExit',
      '--runTestsByPath',
      '__tests__/visioncamera.skia-camera.harness.tsx',
      '--testNamePattern',
      'falls back to the useFrameOutput default when targetResolution is omitted',
      '--json',
      `--outputFile=${path.join(artifacts, 'results.json')}`,
    ],
    'harness.log',
    true,
  )
  exitCode = await harness.done
  clearTimeout(watchdog)
  watchdog = undefined
  if (deadlineExceeded) exitCode = 124
  trace('harness:end', { exitCode })
  clearInterval(hostInterval)
  clearInterval(interval)
  clearInterval(appPoll)
  appPoll = undefined
  for (const timer of timers) clearTimeout(timer)
  await capture('final', exitCode !== 0)
  await command(
    'simcamctl',
    [
      'diagnostics',
      '--device',
      udid,
      '--app',
      process.env.HARNESS_IOS_BUNDLE_ID,
    ],
    'simcam-diagnostics.json',
  )
} catch (error) {
  trace('runner-error', { error: String(error), stack: error.stack })
} finally {
  clearInterval(hostInterval)
  clearInterval(interval)
  clearInterval(appPoll)
  appPoll = undefined
  clearTimeout(watchdog)
  watchdog = undefined
  clearTimeout(hardStop)
  for (const timer of timers) clearTimeout(timer)
  stopChildren()
  // Allow recordVideo to finalize its MP4, then bound cleanup as well.
  const cleanupDeadline = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
  }, 10_000)
  await Promise.all([
    hostProbe,
    ...captures,
    ...[...children].map(
      (child) => new Promise((resolve) => child.once('close', resolve)),
    ),
  ])
  clearTimeout(cleanupDeadline)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  const crashDirectory = path.join(homedir(), 'Library/Logs/DiagnosticReports')
  for (const name of await readdir(crashDirectory).catch(() => [])) {
    if (!/^(SimpleCamera|SimCam|HarnessXCTestAgent)/.test(name)) continue
    const file = path.join(crashDirectory, name)
    const info = await stat(file)
    if (info.isFile() && info.mtimeMs >= startedAt)
      await copyFile(file, path.join(artifacts, name))
  }
  trace('diagnostics-complete', { exitCode })
}
process.exitCode = exitCode
