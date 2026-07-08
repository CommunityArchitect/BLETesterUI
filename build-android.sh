#!/usr/bin/env bash
# =============================================================================
# BLE 5.0 Tester — Local Android build script (Ubuntu / Debian)
# =============================================================================
# Prerequisites (install once):
#   1. JDK 17:   sudo apt install openjdk-17-jdk
#   2. Android SDK with build tools (adb confirms the SDK is present).
#      If ANDROID_HOME is unset:
#        export ANDROID_HOME=$HOME/Android/Sdk
#        export PATH=$PATH:$ANDROID_HOME/platform-tools
#   3. pnpm (already installed per your setup)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$REPO_ROOT/artifacts/mobile"

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
  for candidate in "$HOME/Android/Sdk" "$HOME/.android/sdk" "/opt/android-sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate"
      export PATH="$PATH:$ANDROID_HOME/platform-tools"
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
cd "$REPO_ROOT"
pnpm install 2>&1 | tail -5

# ── 4. Prebuild ────────────────────────────────────────────────────────────────
echo ""
echo "▶  Running expo prebuild (generates android/ native project)..."
cd "$MOBILE_DIR"
EXPO_USE_COMMUNITY_AUTOLINKING=1 NODE_ENV=development pnpm exec expo prebuild --platform android --clean

# ── 5. Gradle build ────────────────────────────────────────────────────────────
echo ""
echo "▶  Building APK with Gradle..."
cd "$MOBILE_DIR/android"

# EXPO_USE_COMMUNITY_AUTOLINKING=1  — must also be set here so that the Gradle
#   tasks spawned during the build see it (belt-and-suspenders).
# NODE_ENV=development              — required by expo-constants during the build
EXPO_USE_COMMUNITY_AUTOLINKING=1 \
NODE_ENV=development \
  ./gradlew assembleDebug --no-daemon 2>&1 | tail -40

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK" ]; then
  echo ""
  echo "❌  APK not found at expected path: $MOBILE_DIR/android/$APK"
  echo "   Run again with --stacktrace for a full error log:"
  echo "   cd $MOBILE_DIR/android"
  echo "   EXPO_USE_COMMUNITY_AUTOLINKING=1 NODE_ENV=development \\"
  echo "     ./gradlew assembleDebug --stacktrace 2>&1 | tee /tmp/gradle.log"
  exit 1
fi

echo ""
echo "✔  APK built: $MOBILE_DIR/android/$APK"
echo "   Size: $(du -sh "$APK" | cut -f1)"

# ── 6. Install via adb ────────────────────────────────────────────────────────
echo ""
echo "▶  Looking for connected Android devices..."
DEVICES=$(adb devices 2>/dev/null | grep -v "^List" | grep "device$" | wc -l)

if [ "$DEVICES" -eq 0 ]; then
  echo "⚠  No Android device connected via adb."
  echo "   Connect with USB debugging enabled, then run:"
  echo "   adb install -r $MOBILE_DIR/android/$APK"
else
  echo "✔  Found $DEVICES device(s). Installing APK..."
  adb install -r "$APK"
  echo ""
  echo "✔  Installed! Open 'BLE 5.0 Tester' on your device."
  echo ""
  if [ "$DEVICES" -gt 1 ]; then
    echo "   Multiple devices detected — adb installed to all."
  else
    echo "   To install on a second device:"
    echo "   adb -s <SERIAL> install -r $MOBILE_DIR/android/$APK"
    echo "   (list serials with: adb devices)"
  fi
fi

echo ""
echo "════════════════════════════════════════════"
echo " Done."
echo "════════════════════════════════════════════"
echo ""
