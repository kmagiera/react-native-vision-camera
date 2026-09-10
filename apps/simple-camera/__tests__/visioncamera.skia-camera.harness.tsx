import { StyleSheet } from 'react-native'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  render,
} from 'react-native-harness'
import type { CameraDevice, Size } from 'react-native-vision-camera'
import { CommonResolutions, VisionCamera } from 'react-native-vision-camera'
import { SkiaCamera } from 'react-native-vision-camera-skia'
import {
  clearSurfacesCache,
  getSurface,
} from 'react-native-vision-camera-skia/src/SurfacesCache'
import { provider as workletsProvider } from 'react-native-vision-camera-worklets'
import { scheduleOnRN } from 'react-native-worklets'
import { deferred, withTimeout } from './test-utils'

// Temporary diagnostics for the isolated CI run; independent of Harness's
// result channel so we retain progress even when its bridge times out.
let lastStage = 'module:loaded'
let deliveredFrames = 0
let heartbeat: ReturnType<typeof setInterval> | undefined
function diagnostic(stage: string, details: Record<string, unknown> = {}) {
  if (stage !== 'heartbeat') lastStage = stage
  const event = { timestamp: new Date().toISOString(), stage, ...details }
  console.log('[skia-diagnostic]', JSON.stringify(event))
  void fetch('http://127.0.0.1:18765/phase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch((error) =>
    console.warn('[skia-diagnostic] collector unavailable', String(error)),
  )
}
diagnostic('module:loaded')

interface Edges {
  short: number
  long: number
}

function getEdges(size: Size): Edges {
  return {
    short: Math.min(size.width, size.height),
    long: Math.max(size.width, size.height),
  }
}

function supportsResolution(device: CameraDevice, size: Size): boolean {
  const target = getEdges(size)
  return device.getSupportedResolutions('video').some((resolution) => {
    const edges = getEdges(resolution)
    return edges.short === target.short && edges.long === target.long
  })
}

/**
 * Renders a `<SkiaCamera />` with the given `targetResolution` and resolves
 * with the dimensions of the first Frame it actually streams.
 */
async function streamFrameSize(
  device: CameraDevice,
  targetResolution: Size | undefined,
): Promise<Size> {
  const received = deferred<Size>()
  const report = (width: number, height: number) => {
    deliveredFrames += 1
    if (deliveredFrames === 1) diagnostic('frame:first', { width, height })
    if (width > 0 && height > 0) received.resolve({ width, height })
  }

  let unmount: (() => void) | undefined
  try {
    diagnostic('render:begin', {
      targetResolution: targetResolution ?? null,
      timeout: 10_000,
    })
    const rendered = await render(
      <SkiaCamera
        ref={(value) => diagnostic('skia:ref', { attached: value != null })}
        device={device}
        isActive={true}
        style={StyleSheet.absoluteFill}
        targetResolution={targetResolution}
        onStarted={() => diagnostic('session:started')}
        onStopped={() => diagnostic('session:stopped')}
        onError={(error) => {
          diagnostic('camera:error', {
            error: String(error),
            stack: error.stack,
          })
          received.reject(error)
        }}
        onFrame={(frame, renderFrame) => {
          'worklet'
          scheduleOnRN(report, frame.width, frame.height)
          renderFrame(({ frameTexture, canvas }) => {
            'worklet'
            canvas.drawImage(frameTexture, 0, 0)
          })
          frame.dispose()
        }}
      />,
      { timeout: 10_000 },
    )
    unmount = rendered.unmount
    diagnostic('render:resolved', { deliveredFrames })

    const size = await withTimeout(
      received.promise,
      15_000,
      `SkiaCamera Frame at ${targetResolution?.width}x${targetResolution?.height}`,
    )
    diagnostic('frame:received', { ...size, deliveredFrames })
    return size
  } catch (error) {
    diagnostic('stream:error', {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  } finally {
    diagnostic('unmount:begin')
    unmount?.()
    diagnostic('unmount:end')
  }
}

/**
 * Configures a bare `CameraFrameOutput` (the same primitive `<Camera />` uses)
 * with the given `targetResolution` and resolves with its negotiated resolution.
 */
async function nativeFrameOutputSize(
  device: CameraDevice,
  targetResolution: Size,
): Promise<Size> {
  const session = await VisionCamera.createCameraSession(false)
  const frameOutput = VisionCamera.createFrameOutput({
    targetResolution,
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    allowDeferredStart: false,
    enablePhysicalBufferRotation: false,
    enableCameraMatrixDelivery: false,
    enablePreviewSizedOutputBuffers: false,
  })
  await session.configure([
    {
      input: device,
      outputs: [{ output: frameOutput, mirrorMode: 'auto' }],
      constraints: [{ resolutionBias: frameOutput }],
    },
  ])

  const received = deferred<Size>()
  const report = (width: number, height: number) => {
    if (width > 0 && height > 0) received.resolve({ width, height })
  }
  const errorSub = session.addOnErrorListener(received.reject)

  const runtime = workletsProvider.createRuntimeForThread(frameOutput.thread)
  runtime.setOnFrameCallback(frameOutput, (frame) => {
    'worklet'
    scheduleOnRN(report, frame.width, frame.height)
    frame.dispose()
  })

  await session.start()
  try {
    return await withTimeout(
      received.promise,
      15_000,
      `CameraFrameOutput Frame at ${targetResolution.width}x${targetResolution.height}`,
    )
  } finally {
    runtime.setOnFrameCallback(frameOutput, undefined)
    errorSub.remove()
    await session.stop()
  }
}

describe('VisionCamera - SkiaCamera targetResolution', () => {
  let backDevice: CameraDevice

  beforeAll(async () => {
    heartbeat = setInterval(
      () => diagnostic('heartbeat', { lastStage, deliveredFrames }),
      2000,
    )
    diagnostic('permission:request')
    await VisionCamera.requestCameraPermission()
    diagnostic('permission:resolved', {
      status: VisionCamera.cameraPermissionStatus,
    })
    expect(VisionCamera.cameraPermissionStatus).toBe('authorized')
    diagnostic('factory:begin')
    const factory = await VisionCamera.createDeviceFactory()
    diagnostic('factory:resolved')
    const back = factory.getDefaultCamera('back')
    if (back == null) throw new Error('no back camera')
    backDevice = back
    diagnostic('device:ready', {
      resolutions: back.getSupportedResolutions('video'),
    })
  })

  afterAll(() => {
    clearInterval(heartbeat)
    diagnostic('suite:afterAll', { deliveredFrames })
  })

  it('streams Frames at the requested targetResolution', async (context) => {
    const targetResolution = CommonResolutions.FHD_4_3
    if (!supportsResolution(backDevice, targetResolution)) {
      return context.skip(
        'FHD 4:3 video resolution not supported on this device',
      )
    }

    const streamed = await streamFrameSize(backDevice, targetResolution)

    expect(getEdges(streamed)).toEqual(getEdges(targetResolution))
  })

  it('falls back to the useFrameOutput default when targetResolution is omitted', async (context) => {
    diagnostic('test:begin')
    const defaultResolution = CommonResolutions.HD_16_9
    if (!supportsResolution(backDevice, defaultResolution)) {
      diagnostic('test:skipped', { reason: 'HD 16:9 unsupported' })
      return context.skip(
        'HD 16:9 video resolution not supported on this device',
      )
    }

    const streamed = await streamFrameSize(backDevice, undefined)

    expect(getEdges(streamed)).toEqual(getEdges(defaultResolution))
    diagnostic('test:assertions-passed', { streamed, defaultResolution })
  })

  it('negotiates the same resolution as a bare CameraFrameOutput', async (context) => {
    const targetResolution = CommonResolutions.FHD_4_3
    if (!supportsResolution(backDevice, targetResolution)) {
      return context.skip(
        'FHD 4:3 video resolution not supported on this device',
      )
    }

    const skia = await streamFrameSize(backDevice, targetResolution)
    const native = await nativeFrameOutputSize(backDevice, targetResolution)

    expect(getEdges(skia)).toEqual(getEdges(native))
  })
})

describe('VisionCamera - Skia surface cache', () => {
  it('keeps a borrowed Skia surface usable after clearing the cache', () => {
    const surface = getSurface(16, 16)
    const canvas = surface.getCanvas()

    clearSurfacesCache()

    // Like renderToTexture, retain the Surface while using its borrowed Canvas.
    canvas.save()
    canvas.restore()
    const snapshot = surface.makeImageSnapshot()
    try {
      expect({ width: snapshot.width(), height: snapshot.height() }).toEqual({
        width: 16,
        height: 16,
      })
    } finally {
      snapshot.dispose()
    }
  })
})
