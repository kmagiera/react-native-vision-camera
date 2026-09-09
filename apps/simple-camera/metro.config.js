const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [root],
  ...(process.env.HARNESS_SKIA_DIAGNOSTICS_DIR
    ? {
        server: {
          enhanceMiddleware: require('./scripts/skia-metro-diagnostics.cjs')
            .enhanceMiddleware,
        },
      }
    : {}),
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
