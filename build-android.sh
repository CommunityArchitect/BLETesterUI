#!/usr/bin/env bash
# =============================================================================
# BLE 5.0 Tester — Local Android build script (Ubuntu / Debian)
# =============================================================================
# Prerequisites (install once):
#   1. JDK 17:
#        sudo apt install openjdk-17-jdk
#   2. Android SDK with build tools — if you have `adb` working, you likely
#      already have the SDK. Verify: echo $ANDROID_HOME
#      If ANDROID_HOME is unset, export it, for example:
#        export ANDROID_HOME=$HOME/Android/Sdk
#        export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator
#   3. pnpm (already installed per your setup)
# =============================================================================
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/artifacts/mobile" && pwd)"
cd "$MOBILE_DIR"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       BLE 5.0 Tester — Android Build     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Check Java ─────────────────────────────────────────────────────────────
if ! command -v java &>/dev/null; then
  echo "❌  Java not found. Install it:"
  echo "    sudo apt install openjdk-17-jdk"
  exit 1
fi
JAVA_VER=$(java -version 2>&1 | head -1)
echo "✔  Java: $JAVA_VER"

# ── 2. Check ANDROID_HOME ─────────────────────────────────────────────────────
if [ -z "${ANDROID_HOME:-}" ]; then
  # Try common Ubuntu paths
  for candidate in "$HOME/Android/Sdk" "$HOME/.android/sdk" "/opt/android-sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools/bin"
      break
    fi
  done
fi

if [ -z "${ANDROID_HOME:-}" ]; then
  echo "❌  ANDROID_HOME is not set. Example:"
  echo "    export ANDROID_HOME=\$HOME/Android/Sdk"
  exit 1
fi
echo "✔  ANDROID_HOME: $ANDROID_HOME"

# ── 3. Install JS dependencies ─────────────────────────────────────────────────
echo ""
echo "▶  Installing JS dependencies..."
cd "$(dirname "$MOBILE_DIR")"  # workspace root
pnpm install --frozen-lockfile 2>&1 | tail -5
cd "$MOBILE_DIR"

# ── 4. Prebuild (generates android/ folder) ───────────────────────────────────
echo ""
echo "▶  Running expo prebuild (generates android/ native project)..."
pnpm exec expo prebuild --platform android --clean

# ── 5. Gradle build ──────────────────────────────────────────────────────────
echo ""
echo "▶  Building APK with Gradle..."
cd android

# Use debug build by default (no signing required)
./gradlew assembleDebug --no-daemon 2>&1 | tail -30

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK" ]; then
  echo "❌  APK not found at: $APK"
  exit 1
fi

echo ""
echo "✔  APK built: $MOBILE_DIR/android/$APK"
echo "   Size: $(du -sh "$APK" | cut -f1)"

# ── 6. Install via adb ────────────────────────────────────────────────────────
echo ""
echo "▶  Looking for connected Android device..."
DEVICES=$(adb devices | grep -v "^List" | grep "device$" | wc -l)

if [ "$DEVICES" -eq 0 ]; then
  echo "⚠  No Android device connected via adb."
  echo "   Connect your device with USB debugging enabled and run:"
  echo "   adb install -r $MOBILE_DIR/android/$APK"
else
  echo "✔  Found $DEVICES device(s). Installing APK..."
  adb install -r "$APK"
  echo ""
  echo "✔  Installed! Look for 'BLE 5.0 Tester' on your device."
  echo ""
  echo "   To install on a second device:"
  echo "   adb -s <DEVICE_SERIAL> install -r $MOBILE_DIR/android/$APK"
  echo ""
  echo "   List connected devices: adb devices"
fi

echo ""
echo "════════════════════════════════════════════"
echo " Done. Run on both test devices to start."
echo "════════════════════════════════════════════"
echo ""
