// Expo config plugin — injects BleGattServer native module into the Android project
// during `expo prebuild`. No separate npm package needed.
const { withDangerousMod, withMainApplication } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const KOTLIN_FILES = ["BleGattServerModule.kt", "BleGattServerPackage.kt"];
const SRC_DIR = path.join(__dirname, "android");

function withBlePeripheral(config) {
  // Step 1 — copy Kotlin source files into the generated android/ project
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const pkgPath = cfg.android?.package?.replace(/\./g, "/") ?? "com/ble5tester/app";
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/java",
        pkgPath
      );
      fs.mkdirSync(destDir, { recursive: true });

      for (const file of KOTLIN_FILES) {
        const src = path.join(SRC_DIR, file);
        const dest = path.join(destDir, file);
        if (!fs.existsSync(src)) throw new Error(`Plugin source file missing: ${src}`);
        let contents = fs.readFileSync(src, "utf8");
        // Replace placeholder package with the real one
        const realPkg = cfg.android?.package ?? "com.ble5tester.app";
        contents = contents.replace(/^package PLACEHOLDER_PACKAGE/m, `package ${realPkg}`);
        fs.writeFileSync(dest, contents, "utf8");
      }
      return cfg;
    },
  ]);

  // Step 2 — register the package in MainApplication.kt
  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const pkg = cfg.android?.package ?? "com.ble5tester.app";

    // Add import if not already present
    const importLine = `import ${pkg}.BleGattServerPackage`;
    if (!contents.includes(importLine)) {
      // Insert after the last existing import block
      contents = contents.replace(
        /(^import .+$)/m,
        `$1\n${importLine}`
      );
    }

    // Add package registration inside getPackages() before the return statement
    if (!contents.includes("BleGattServerPackage()")) {
      contents = contents.replace(
        /(val packages = PackageList\(this\)\.packages[\s\S]*?)(return packages)/,
        `$1packages.add(BleGattServerPackage())\n      $2`
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  return config;
}

module.exports = withBlePeripheral;
