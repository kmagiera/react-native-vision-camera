// Fork-only CI diagnostic. Attach before Harness can start the test, resume
// immediately, and dump the native state only when the process crashes.
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function findAppPid() {
  const deadline = Date.now() + 60_000
  do {
    try {
      const { stdout } = await exec('pgrep', ['-x', 'SimpleCamera'], {
        timeout: 5000,
      })
      const pids = stdout.trim().split(/\s+/).filter(Boolean)
      if (pids.length !== 1) throw new Error(`Ambiguous SimpleCamera PIDs: ${pids}`)
      const { stdout: command } = await exec('ps', ['-p', pids[0], '-o', 'comm='], {
        timeout: 5000,
      })
      if (!command.trim().endsWith('/SimpleCamera.app/SimpleCamera'))
        throw new Error(`Unexpected debugger target: ${command.trim()}`)
      return pids[0]
    } catch (error) {
      if (error.code !== 1) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  throw new Error('SimpleCamera did not launch before the debugger deadline')
}

export async function attachCrashDebugger() {
  const pid = await findAppPid()
  const file = path.join(process.env.HARNESS_SKIA_DIAGNOSTICS_DIR, `lldb-${pid}.log`)
  const output = createWriteStream(file)
  const child = spawn('xcrun', [
    'lldb', '--no-lldbinit', '--batch', '--attach-pid', pid,
    '-O', 'settings set auto-confirm true',
    '-O', 'settings set interpreter.stop-command-source-on-error false',
    '-o', 'process handle --stop false --notify false --pass true SIGPIPE SIGTERM',
    '-o', 'process handle --stop true --notify true --pass true SIGSEGV SIGBUS SIGILL SIGABRT',
    '-o', `script p = lldb.debugger.GetSelectedTarget().GetProcess(); assert p.IsValid() and p.GetProcessID() == ${pid} and p.GetState() == lldb.eStateStopped; print("SKIA_LLDB_ATTACHED", flush=True)`,
    '-o', 'continue',
    '-k', 'process status',
    '-k', 'thread backtrace --count 60 all',
    '-k', 'register read',
    '-k', 'disassemble --pc --count 24',
    '-k', 'image list -o -f',
    '-k', 'process detach --keep-stopped false',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      output.end(`\n[skia-ci] LLDB exited: code=${code} signal=${signal}\n`, resolve)
    })
  })

  try {
    await new Promise((resolve, reject) => {
      let tail = ''
      const timeout = setTimeout(() => settle(new Error('LLDB attach timed out')), 90_000)
      const onError = (error) => settle(error)
      const onClose = (code) => settle(new Error(`LLDB exited before attaching: ${code}; see ${file}`))
      const onData = (chunk) => {
        tail = (tail + chunk.toString()).slice(-4096)
        // Do not match LLDB's echo of the print command itself.
        if (/(?:^|\n)SKIA_LLDB_ATTACHED\r?\n/.test(tail)) settle()
      }
      function settle(error) {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('close', onClose)
        if (error) reject(error)
        else resolve()
      }
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('close', onClose)
    })
  } catch (error) {
    child.kill('SIGINT')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    await done
    clearTimeout(timeout)
    throw error
  }
  console.log(`[skia-ci] LLDB attached to SimpleCamera PID ${pid}; native crash output: ${file}`)
  return {
    async finish() {
      // Called after the normal AppSession has stopped the app. Successful
      // exits need no stack dump; crashed targets dump and detach themselves.
      const interrupt = setTimeout(() => child.kill('SIGINT'), 10_000)
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
      await done
      clearTimeout(interrupt)
      clearTimeout(timeout)
    },
  }
}
