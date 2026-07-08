// Tells the React Native Gradle Plugin (RNGP) autolinking task the Android
// package name explicitly. In a pnpm workspace the file-system scan that RNGP
// normally uses to find `packageName` fails because pnpm's node_modules layout
// differs from npm/yarn. Declaring it here fixes:
//   "Could not find project.android.packageName in react-native config output!"
//
// Root cause of why this alone wasn't enough: the monorepo root was missing
// pnpm-workspace.yaml, so "workspace:*" dependencies (e.g. this package's own
// @workspace/api-client-react) never resolved and node_modules hoisting never
// happened correctly in the first place — see pnpm-workspace.yaml, now added
// at the repo root. sourceDir is included here too since a partial
// project.android override (packageName alone) can leave the rest of the
// object unresolved in some CLI versions.
module.exports = {
  project: {
    android: {
      sourceDir: "android",
      packageName: "com.ble5tester.app",
    },
  },
};

