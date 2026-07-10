import { useCallback, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import { Buffer } from "buffer";
import { getBlePeripheral, getBlePeripheralLoadError } from "@/modules/ble-peripheral";

export type Role = "central" | "peripheral" | null;
export type TestCase = 1 | 2 | 3;

export type Status =
  | "idle"
  | "checking_ble"
  | "ble_unsupported"
  | "advertising"
  | "scanning"
  | "connecting"
  | "connected"
  | "transferring"
  | "done"
  | "error";

export interface BleState {
  role: Role;
  testCase: TestCase;
  status: Status;
  logs: string[];
  sentHash: string | null;
  receivedHash: string | null;
  bleVersion: string | null;
  errorMessage: string | null;
  isRunning: boolean;
  throughputKbps: number | null;
}

export const BLE_APP_SERVICE_UUID    = "12345678-1234-5678-1234-56789abcdef0";
export const BLE_DATA_CHAR_UUID      = "12345678-1234-5678-1234-56789abcdef1";
export const BLE_HASH_CHAR_UUID      = "12345678-1234-5678-1234-56789abcdef2";
export const BLE_DATA_TC2_STREAM_UUID = "12345678-1234-5678-1234-56789abcdef3";
export const BLE_APP_NAME            = "BLE5Tester";
export const TARGET_MTU              = 500;
export const CENTRAL_SCAN_TIMEOUT_MS = 20000;

export const TC_CONFIG = {
  1: { label: "100 B",   payloadBytes: 100 },
  2: { label: "100 KB",  payloadBytes: 100_000 },
  3: { label: "100 KB",  payloadBytes: 100_000 },
} as const;

// BLE PHY constants (Android BluetoothDevice.PHY_LE_*)
const PHY_LE_2M = 2;

function generateRandomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 256);
  return arr;
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    data as unknown as ArrayBuffer
  );
  return Buffer.from(digest).toString("hex");
}

// ── BLE Central manager (native only, lazy import) ────────────────────────────
let BleManagerClass: typeof import("react-native-ble-plx").BleManager | null = null;
let StateEnum: typeof import("react-native-ble-plx").State | null = null;
let managerInstance: import("react-native-ble-plx").BleManager | null = null;

async function getBleManager() {
  if (Platform.OS === "web") return null;
  if (!BleManagerClass) {
    const mod = await import("react-native-ble-plx");
    BleManagerClass = mod.BleManager;
    StateEnum = mod.State;
  }
  return { BleManager: BleManagerClass!, State: StateEnum! };
}

async function getManager() {
  const ble = await getBleManager();
  if (!ble) return null;
  if (!managerInstance) managerInstance = new ble.BleManager();
  return managerInstance;
}

// ─────────────────────────────────────────────────────────────────────────────

export function useBle() {
  const [state, setState] = useState<BleState>({
    role: null,
    testCase: 1,
    status: "idle",
    logs: [],
    sentHash: null,
    receivedHash: null,
    bleVersion: null,
    errorMessage: null,
    isRunning: false,
    throughputKbps: null,
  });

  const stopRef   = useRef(false);
  const deviceRef = useRef<import("react-native-ble-plx").Device | null>(null);

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setState((s) => ({ ...s, logs: [`[${ts}] ${msg}`, ...s.logs].slice(0, 200) }));
  }, []);

  const setStatus = useCallback((status: Status) => {
    setState((s) => ({ ...s, status }));
  }, []);

  const setRole = useCallback((role: Role) => {
    setState((s) => ({
      ...s, role, logs: [], sentHash: null,
      receivedHash: null, errorMessage: null, status: "idle", throughputKbps: null,
    }));
  }, []);

  const setTestCase = useCallback((testCase: TestCase) => {
    setState((s) => ({
      ...s, testCase, logs: [], sentHash: null,
      receivedHash: null, errorMessage: null, status: "idle", throughputKbps: null,
    }));
  }, []);

  // ── BLE adapter check ──────────────────────────────────────────────────────
  const checkBleVersion = useCallback(async (): Promise<boolean> => {
    setStatus("checking_ble");
    log("Checking BLE adapter...");

    if (Platform.OS === "web") {
      log("BLE not supported on web. Use a physical Android device.");
      setState((s) => ({
        ...s,
        bleVersion: "Web — BLE not supported",
        errorMessage: "BLE requires a physical Android device.",
      }));
      return false;
    }

    const mod = await getBleManager();
    if (!mod) return false;
    const manager = await getManager();
    if (!manager) return false;

    return new Promise((resolve) => {
      const sub = manager.onStateChange((bleState) => {
        if (bleState === mod.State.PoweredOn) {
          sub.remove();
          log("BLE adapter on — BLE 5.0+ (Android API 26+).");
          setState((s) => ({ ...s, bleVersion: "BLE 5.0+ (Android)" }));
          resolve(true);
        } else if (
          bleState === mod.State.Unsupported ||
          bleState === mod.State.Unauthorized
        ) {
          sub.remove();
          log(`BLE unavailable: ${bleState}. Check permissions and Bluetooth.`);
          setState((s) => ({
            ...s, bleVersion: bleState,
            errorMessage: `BLE unavailable: ${bleState}`,
          }));
          resolve(false);
        }
      }, true);

      setTimeout(() => {
        sub.remove();
        log("BLE adapter check timed out. Is Bluetooth enabled?");
        setState((s) => ({ ...s, errorMessage: "BLE adapter check timed out." }));
        resolve(false);
      }, 10000);
    });
  }, [log, setStatus]);

  // ── Peripheral role ────────────────────────────────────────────────────────
  const runAsPeripheral = useCallback(async (testCase: TestCase) => {
    const { payloadBytes: size, label } = TC_CONFIG[testCase];
    log(`TC${testCase}: generating ${label} random payload (${size.toLocaleString()} bytes)...`);
    const payload = generateRandomBytes(size);
    const hash    = await sha256hex(payload);
    setState((s) => ({ ...s, sentHash: hash }));
    log(`SHA-256: ${hash}`);

    const peripheral = Platform.OS === "android" ? getBlePeripheral() : null;

    if (!peripheral) {
      const loadError = getBlePeripheralLoadError();
      log("");
      log("⚠  BlePeripheral native module not found.");
      log(`   Platform: ${Platform.OS}, load error: ${loadError ?? "(none reported)"}`);
      log("   This is normal in Expo Go — it requires a custom native build.");
      log("   Run build-android.sh on Ubuntu to get the full APK.");
      log("");
      log("   GATT config for reference:");
      log(`   Service UUID:     ${BLE_APP_SERVICE_UUID}`);
      log(`   Advert name:      ${BLE_APP_NAME}`);
      log(`   TC2 stream char:  ${BLE_DATA_TC2_STREAM_UUID}`);
      setStatus("done");
      return;
    }

    setStatus("advertising");
    log("Native BlePeripheral module loaded.");
    log(`Starting GATT server for TC${testCase} (${size.toLocaleString()} bytes)...`);
    log(`Advertising as "${BLE_APP_NAME}" · Service: ${BLE_APP_SERVICE_UUID}`);

    try {
      const payloadBase64 = Buffer.from(payload).toString("base64");
      await peripheral.startServer(payloadBase64, hash);
      log("✓ GATT server running and advertising confirmed by the OS.");
      if (testCase === 2 || testCase === 3) {
        log(`  TC${testCase}: central must subscribe to ${BLE_DATA_TC2_STREAM_UUID}`);
        log("  Streaming starts automatically on subscription.");
        if (testCase === 3) {
          log("  TC3: PHY is negotiated by the Central (2M PHY request); no peripheral action needed.");
        }
      }
      log("  Press Stop after the Central finishes.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Failed to start GATT server: ${msg}`);
      log("  Check `adb logcat -s BlePeripheral:V` for native error detail.");
      setState((s) => ({ ...s, errorMessage: msg }));
      setStatus("error");
    }
  }, [log, setStatus]);

  // ── Central: scan & connect (shared between TC1 and TC2) ──────────────────
  const scanAndConnect = useCallback(async (
    manager: import("react-native-ble-plx").BleManager,
    testCase: TestCase
  ): Promise<import("react-native-ble-plx").Device | null> => {
    stopRef.current = false;
    setStatus("scanning");
    log(`Scanning for "${BLE_APP_NAME}" (no UUID filter — logging every device)...`);
    log(`Expected service UUID: ${BLE_APP_SERVICE_UUID}`);
    log(`Scan timeout: ${CENTRAL_SCAN_TIMEOUT_MS / 1000}s`);

    let foundDevice: import("react-native-ble-plx").Device | null = null;
    const seenDeviceIds = new Set<string>();

    await new Promise<void>((resolve, reject) => {
      manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (stopRef.current) { manager.stopDeviceScan(); resolve(); return; }
        if (error) { manager.stopDeviceScan(); reject(new Error(error.message)); return; }
        if (!device) return;

        if (!seenDeviceIds.has(device.id)) {
          seenDeviceIds.add(device.id);
          log(
            `  seen: name="${device.name ?? "(none)"}" id=${device.id} rssi=${device.rssi ?? "?"} ` +
            `serviceUUIDs=${device.serviceUUIDs?.length ? device.serviceUUIDs.join(",") : "(none)"}`
          );
        }

        const matchesName    = device.name === BLE_APP_NAME;
        const matchesService = !!device.serviceUUIDs?.some(
          (u) => u.toLowerCase() === BLE_APP_SERVICE_UUID.toLowerCase()
        );
        if (matchesName || matchesService) {
          log(`Found target: "${device.name ?? "(unnamed)"}" (${device.id}) name=${matchesName} svc=${matchesService}`);
          manager.stopDeviceScan();
          foundDevice = device;
          resolve();
        }
      });

      setTimeout(() => {
        if (!foundDevice) {
          manager.stopDeviceScan();
          reject(new Error(
            `Scan timeout (${CENTRAL_SCAN_TIMEOUT_MS / 1000}s): "${BLE_APP_NAME}" not found.\n` +
            `Devices seen: ${seenDeviceIds.size}.\n` +
            "Troubleshooting:\n" +
            "  - Peripheral must show '✓ GATT server running' before Central scans.\n" +
            "  - Ensure Bluetooth is ON and Location permission is granted.\n" +
            "  - Android requires Location services enabled for BLE scanning on most OEMs.\n" +
            "  - Move devices closer together and retry."
          ));
        }
      }, CENTRAL_SCAN_TIMEOUT_MS);
    });

    if (!foundDevice || stopRef.current) return null;

    setStatus("connecting");
    log("Connecting...");
    let conn = await (foundDevice as import("react-native-ble-plx").Device).connect();

    // Request BALANCED connection priority (CONNECTION_PRIORITY_BALANCED=0).
    // Android negotiates roughly a 30-50ms interval for this bucket, versus
    // ~11.25-15ms for HIGH. Android only exposes these three coarse priority
    // buckets (Balanced/High/LowPower) - it does not let apps pin an exact
    // millisecond interval.
    try {
      log("Requesting BALANCED connection priority...");
      conn = await conn.requestConnectionPriority(0);
    } catch (e) {
      log(`requestConnectionPriority failed (continuing anyway): ${e instanceof Error ? e.message : String(e)}`);
    }

    if (testCase === 3) {
      try {
        log("TC3: requesting LE 2M PHY (BLE 5.0 high-speed radio)...");
        conn = await conn.requestPreferredPhy(PHY_LE_2M, PHY_LE_2M, 0);
        log("✓ 2M PHY request sent (Android negotiates with peer; no direct readback via this API).");
      } catch (e) {
        log(`requestPreferredPhy failed (continuing on 1M PHY): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    log(`Connected. Requesting MTU ${TARGET_MTU}...`);
    conn = await conn.requestMTU(TARGET_MTU);
    log(`MTU negotiated: ${conn.mtu ?? "unknown"}`);
    deviceRef.current = conn;

    setStatus("transferring");
    log("Discovering services & characteristics...");
    conn = await conn.discoverAllServicesAndCharacteristics();
    return conn;
  }, [log, setStatus]);

  // ── Central TC1: single READ, 100 bytes ───────────────────────────────────
  const runAsCentralTc1 = useCallback(async (
    conn: import("react-native-ble-plx").Device
  ) => {
    log("TC1: Reading data characteristic (100 bytes)...");
    const dataChar = await conn.readCharacteristicForService(
      BLE_APP_SERVICE_UUID, BLE_DATA_CHAR_UUID
    );
    const rawData = dataChar.value ? Buffer.from(dataChar.value, "base64") : Buffer.alloc(0);
    log(`Received ${rawData.length} bytes.`);

    log("Reading hash characteristic...");
    const hashChar = await conn.readCharacteristicForService(
      BLE_APP_SERVICE_UUID, BLE_HASH_CHAR_UUID
    );
    const peripheralHash = hashChar.value
      ? Buffer.from(hashChar.value, "base64").toString("utf8")
      : "";
    log(`Peripheral hash: ${peripheralHash}`);

    const localHash = await sha256hex(new Uint8Array(rawData));
    setState((s) => ({ ...s, receivedHash: localHash }));
    log(`Local hash:      ${localHash}`);

    if (localHash === peripheralHash) {
      log("✓ HASH MATCH — 100 bytes transferred and verified!");
    } else {
      log("✗ HASH MISMATCH — data corruption detected.");
    }
  }, [log]);

  // ── Central TC2/TC3: NOTIFY stream, 100 KB, timed (TC3 adds 2M PHY) ───────
  const runAsCentralStream = useCallback(async (
    conn: import("react-native-ble-plx").Device,
    testCase: 2 | 3
  ) => {
    const EXPECTED = TC_CONFIG[testCase].payloadBytes;
    log(`TC${testCase}: subscribing to stream characteristic (expecting ${EXPECTED.toLocaleString()} bytes)...`);
    log(`  Stream UUID: ${BLE_DATA_TC2_STREAM_UUID}`);

    const chunks: Buffer[] = [];
    let totalReceived = 0;
    const transferStart = Date.now();
    const LOG_EVERY = Math.floor(EXPECTED / 10); // log every ~10%
    let nextLogAt = LOG_EVERY;

    await new Promise<void>((resolve, reject) => {
      const sub = conn.monitorCharacteristicForService(
        BLE_APP_SERVICE_UUID,
        BLE_DATA_TC2_STREAM_UUID,
        (err, char) => {
          if (stopRef.current) { sub.remove(); resolve(); return; }
          if (err) { sub.remove(); reject(new Error(err.message)); return; }
          if (!char?.value) return;

          const chunk = Buffer.from(char.value, "base64");
          chunks.push(chunk);
          totalReceived += chunk.length;

          if (totalReceived >= nextLogAt || totalReceived >= EXPECTED) {
            const pct = Math.round(totalReceived * 100 / EXPECTED);
            log(`  ${totalReceived.toLocaleString()} / ${EXPECTED.toLocaleString()} bytes (${pct}%)...`);
            nextLogAt += LOG_EVERY;
          }

          if (totalReceived >= EXPECTED) {
            sub.remove();
            resolve();
          }
        }
      );

      // Timeout: 100KB at even the slowest BLE rate should arrive in <60s
      setTimeout(() => {
        sub.remove();
        reject(new Error(
          `TC2 stream timeout: received ${totalReceived.toLocaleString()} / ${EXPECTED.toLocaleString()} bytes.\n` +
          "Check `adb logcat -s BlePeripheral:V` on the peripheral device."
        ));
      }, 60_000);
    });

    const elapsedMs = Date.now() - transferStart;
    const kbps = ((totalReceived / 1024) / (elapsedMs / 1000));
    setState((s) => ({ ...s, throughputKbps: kbps }));
    log(`Transfer complete: ${totalReceived.toLocaleString()} bytes in ${(elapsedMs / 1000).toFixed(2)}s`);
    log(`Throughput: ${kbps.toFixed(1)} kB/s  (${(kbps * 8).toFixed(1)} kbit/s)`);

    // Reassemble and verify
    const allData = Buffer.concat(chunks);
    log("Reading hash characteristic...");
    const hashChar = await conn.readCharacteristicForService(
      BLE_APP_SERVICE_UUID, BLE_HASH_CHAR_UUID
    );
    const peripheralHash = hashChar.value
      ? Buffer.from(hashChar.value, "base64").toString("utf8")
      : "";
    log(`Peripheral hash: ${peripheralHash}`);

    const localHash = await sha256hex(new Uint8Array(allData));
    setState((s) => ({ ...s, receivedHash: localHash }));
    log(`Local hash:      ${localHash}`);

    if (localHash === peripheralHash) {
      log(`✓ HASH MATCH — ${totalReceived.toLocaleString()} bytes verified at ${kbps.toFixed(1)} kB/s!`);
    } else {
      log("✗ HASH MISMATCH — data corruption detected.");
    }
  }, [log]);

  // ── Central role dispatcher ────────────────────────────────────────────────
  const runAsCentral = useCallback(async (testCase: TestCase) => {
    const manager = await getManager();
    if (!manager) { log("BleManager unavailable."); setStatus("error"); return; }

    let conn: import("react-native-ble-plx").Device | null = null;
    try {
      conn = await scanAndConnect(manager, testCase);
      if (!conn || stopRef.current) return;

      if (testCase === 1) {
        await runAsCentralTc1(conn);
      } else {
        await runAsCentralStream(conn, testCase);
      }

      await conn.cancelConnection();
      log("Disconnected cleanly.");
      setStatus("done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error: ${msg}`);
      setState((s) => ({ ...s, errorMessage: msg }));
      setStatus("error");
    }
  }, [log, setStatus, scanAndConnect, runAsCentralTc1, runAsCentralStream]);

  // ── Play / Stop / Reset ───────────────────────────────────────────────────
  const play = useCallback(async () => {
    setState((s) => ({
      ...s, isRunning: true, logs: [],
      sentHash: null, receivedHash: null, errorMessage: null, throughputKbps: null,
    }));

    // Capture stable values from state before any async work.
    const { role, testCase } = state;

    try {
      const bleOk = await checkBleVersion();
      if (!bleOk) {
        setStatus("ble_unsupported");
        setState((s) => ({ ...s, isRunning: false }));
        return;
      }
      if (role === "peripheral") await runAsPeripheral(testCase);
      else if (role === "central") await runAsCentral(testCase);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Fatal: ${msg}`);
      setState((s) => ({ ...s, errorMessage: msg }));
      setStatus("error");
    }

    setState((s) => ({ ...s, isRunning: false }));
  }, [state, checkBleVersion, runAsPeripheral, runAsCentral, log, setStatus]);

  const stop = useCallback(async () => {
    stopRef.current = true;
    if (deviceRef.current) {
      try { await deviceRef.current.cancelConnection(); } catch { /* ignore */ }
      deviceRef.current = null;
    }
    const manager = await getManager();
    manager?.stopDeviceScan();
    const peripheral = Platform.OS === "android" ? getBlePeripheral() : null;
    if (peripheral) {
      try {
        await peripheral.stopServer();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error stopping GATT server: ${msg}`);
      }
    }
    setState((s) => ({ ...s, isRunning: false, status: "idle" }));
    log("Stopped.");
  }, [log]);

  const reset = useCallback(async () => {
    await stop();
    setState((s) => ({
      ...s, status: "idle", logs: [],
      sentHash: null, receivedHash: null, errorMessage: null, throughputKbps: null,
    }));
  }, [stop]);

  return { state, setRole, setTestCase, play, stop, reset };
}
