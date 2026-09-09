// Temporary fork-only wrapper: retain the normal Apple runner and export the
// native console it already buffers. Optionally catch a crash with LLDB.
import { applePlatform } from '@react-native-harness/platform-apple'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { attachCrashDebugger } from './skia-crash-debugger.mjs'

export default async function runAppleWithNativeLogs(config, harnessConfig, init) {
  const { default: runApple } = await import(applePlatform(config).runner)
  const runner = await runApple(config, harnessConfig, init)
  return {
    ...runner,
    async createAppSession(options) {
      const session = await runner.createAppSession(options)
      let debuggerSession
      try {
        if (process.env.HARNESS_SKIA_LLDB === '1')
          debuggerSession = await attachCrashDebugger()
      } catch (error) {
        await session.dispose()
        throw error
      }
      return {
        ...session,
        async dispose() {
          try {
            await session.dispose()
          } finally {
            await debuggerSession?.finish()
            const record = {
              timestamp: new Date().toISOString(),
              logs: session.getLogs(),
            }
            await appendFile(
              path.join(
                process.env.HARNESS_SKIA_DIAGNOSTICS_DIR,
                'native-app-sessions.ndjson',
              ),
              `${JSON.stringify(record)}\n`,
            ).catch((error) =>
              console.warn('[skia-ci] Native console export failed:', error),
            )
          }
        },
      }
    },
  }
}
