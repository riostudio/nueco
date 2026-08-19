/**
 * ffmpeg-kit-react-native (Audio-Launch 16KB fork) resolves its bundled AAR through a flatDir
 * repository declared on the library project. Gradle resolves library dependencies using the
 * APP project's repositories, so the flatDir must also be registered there - this plugin adds
 * it to the generated android/build.gradle at prebuild time.
 */
const { withProjectBuildGradle } = require('@expo/config-plugins');

const FLAT_DIR_LINE =
  'flatDir { dirs "$rootDir/../node_modules/ffmpeg-kit-react-native/android/libs" } // ffmpeg-kit-libs';

module.exports = function withFfmpegLibsDir(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withFfmpegLibsDir expects a Groovy android/build.gradle');
    }
    if (!cfg.modResults.contents.includes('ffmpeg-kit-libs')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /allprojects\s*{\s*repositories\s*{/,
        `allprojects {\n    repositories {\n        ${FLAT_DIR_LINE}`,
      );
    }
    return cfg;
  });
};
