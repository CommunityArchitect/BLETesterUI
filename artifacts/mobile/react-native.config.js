// Tells the React Native Gradle Plugin (RNGP) autolinking task the Android
// package name explicitly. In a pnpm workspace the file-system scan that RNGP
// normally uses to find `packageName` fails because pnpm's node_modules layout
// differs from npm/yarn. Declaring it here fixes:
//   "Could not find project.android.packageName in react-native config output!"
module.exports = {
  project: {
    android: {
      packageName: "com.ble5tester.app",
    },
  },
};
