// Fork-only Skia comparison: MLKit's simulator binary prevents an arm64 build.
// This test does not use barcode scanning; keep normal app linkage by default.
module.exports = {
  dependencies:
    process.env.HARNESS_DISABLE_BARCODE === '1'
      ? {
          'react-native-vision-camera-barcode-scanner': {
            platforms: { ios: null },
          },
        }
      : {},
}
