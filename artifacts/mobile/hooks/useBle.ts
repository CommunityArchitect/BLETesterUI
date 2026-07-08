import { useCallback, useRef, useState } from "react";
  import { Platform } from "react-native";
  import * as Crypto from "expo-crypto";
  import { Buffer } from "buffer";
  import { getBlePeripheral, getBlePeripheralLoadError } from "@/modules/ble-peripheral";

  export type Role = "central" | "peripheral" | null;
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
    status: Status;
    logs: string[];
    sentHash: string | null;
    receivedHash: string | null;
    bleVersion: string | null;
    errorMessage: string | null;
    isRunning: boolean;
  }

  export const BLE_APP_SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
  export const BLE_DATA_CHAR_UUID   = "12345678-1234-5678-1234-56789abcdef1";
  export const BLE_HASH_CHAR_UUID   = "12345678-1234-5678-1234-56789abcdef2";
  export const BLE_APP_NAME         = "BLE5Tester";
  export const PAYLOAD_BYTES        = 100;
  export const TARGET_MTU           = 500;
  export const CENTRAL_SCAN_TIMEOUT_MS = 20000;

  function generateRandomBytes(length: number): Uint8Array {
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
  }

  async function sha256hex(data: Uint8Array): Promise<string> {
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data.slice().buffer as ArrayBuffer);
    return Buffer.from(digest).toString("hex");
  }

  // ── BLE Central manager (native only, lazy import) ───────────────────────────
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
      status: "idle",
      logs: [],
      sentHash: null,
      receivedHash: null,
      bleVersion: null,
      errorMessage: null,
      isRunning: false,
    });

    const stopRef   = useRef(false);
    const deviceRef = useRef<import("react-native-ble-plx").Device | null>(null);

    const log = useCallback((msg: string) => {
      const ts = new Date().toLocaleTimeString();
      setState((s) => ({ ...s, logs: [`[${ts}] ${msg}`, ...s.logs].slice(0, 100) }));
    }, []);

    const setStatus = useCallback((status: Status) => {
      setState((s) => ({ ...s, status }));
    }, []);

    const setRole = useCallback((role: Role) => {
      setState((s) => ({
        ...s, role, logs: [], sentHash: null,
        receivedHash: null, errorMessage: null, status: "idle",
      }));
    }, []);

    // ── BLE version / adapter check ─────────────────────────────────────────────
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
              ...s,
              bleVersion: bleState,
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

    // ── Peripheral role ──────────────────────────────────────────────────────────
    const runAsPeripheral = useCallback(async () => {
      log("Generating 100-byte random payload...");
      const payload = generateRandomBytes(PAYLOAD_BYTES);
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
        log("   Run build-android.sh on Ubuntu to get the full APK with");
        log("   GATT server support built in.");
        log("");
        log("   GATT config for reference:");
        log(`   Service UUID: ${BLE_APP_SERVICE_UUID}`);
        log(`   Advert name:  ${BLE_APP_NAME}`);
        setStatus("done");
        return;
      }

      setStatus("advertising");
      log("Native BlePeripheral module loaded.");
      log("Starting GATT server...");
      log(`Advertising as "${BLE_APP_NAME}"`);
      log(`Service: ${BLE_APP_SERVICE_UUID}`);

      try {
        const payloadBase64 = Buffer.from(payload).toString("base64");
        log(`Calling native startServer() with ${payload.length}-byte payload...`);
        await peripheral.startServer(payloadBase64, hash);
        log("✓ GATT server running and advertising confirmed by the OS.");
        log("  Waiting for Central to connect. Check `adb logcat -s BlePeripheral:V` for native-side detail.");
        log("  Press Stop after the Central finishes.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`✗ Failed to start GATT server: ${msg}`);
        log("  Check `adb logcat -s BlePeripheral:V` on this device for the native error detail.");
        setState((s) => ({ ...s, errorMessage: msg }));
        setStatus("error");
      }
    }, [log, setStatus]);

    // ── Central role ─────────────────────────────────────────────────────────────
    const runAsCentral = useCallback(async () => {
      const manager = await getManager();
      if (!manager) { log("BleManager unavailable."); setStatus("error"); return; }

      stopRef.current = false;
      setStatus("scanning");
      log(`Scanning for "${BLE_APP_NAME}" (no UUID filter — logging every device seen)...`);
      log(`Expected service UUID: ${BLE_APP_SERVICE_UUID}`);
      log(`Scan timeout: ${CENTRAL_SCAN_TIMEOUT_MS / 1000}s`);

      let foundDevice: import("react-native-ble-plx").Device | null = null;
      const seenDeviceIds = new Set<string>();

      try {
        await new Promise<void>((resolve, reject) => {
          manager.startDeviceScan(
            null,
            { allowDuplicates: false },
            (error, device) => {
              if (stopRef.current) { manager.stopDeviceScan(); resolve(); return; }
              if (error) { manager.stopDeviceScan(); reject(new Error(error.message)); return; }
              if (!device) return;

              if (!seenDeviceIds.has(device.id)) {
                seenDeviceIds.add(device.id);
                log(
                  `  seen: name="${device.name ?? "(none)"}" id=${device.id} rssi=${device.rssi ?? "?"} ` +
                  `serviceUUIDs=${device.serviceUUIDs && device.serviceUUIDs.length ? device.serviceUUIDs.join(",") : "(none advertised)"}`
                );
              }

              const matchesName = device.name === BLE_APP_NAME;
              const matchesService = !!device.serviceUUIDs?.some(
                (u) => u.toLowerCase() === BLE_APP_SERVICE_UUID.toLowerCase()
              );

              if (matchesName || matchesService) {
                log(`Found target device: ${device.name ?? "(unnamed)"} (${device.id}) matchesName=${matchesName} matchesService=${matchesService}`);
                manager.stopDeviceScan();
                foundDevice = device;
                resolve();
              }
            }
          );
          setTimeout(() => {
            if (!foundDevice) {
              manager.stopDeviceScan();
              reject(new Error(
                `Scan timeout (${CENTRAL_SCAN_TIMEOUT_MS / 1000}s): "${BLE_APP_NAME}" not found.\n` +
                `Devices seen during scan: ${seenDeviceIds.size}.\n` +
                "Troubleshooting:\n" +
                "  - Ensure the Peripheral device pressed Play first and shows '✓ GATT server running'.\n" +
                "  - Ensure Bluetooth is ON and Location permission is granted on this (Central) device.\n" +
                "  - Android requires Location services enabled for BLE scanning on many OEMs.\n" +
                "  - Move the two devices closer together and retry."
              ));
            }
          }, CENTRAL_SCAN_TIMEOUT_MS);
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Scan error: ${msg}`);
        setState((s) => ({ ...s, errorMessage: msg }));
        setStatus("error");
        return;
      }

      if (!foundDevice || stopRef.current) return;

      setStatus("connecting");
      log("Connecting...");

      try {
        let conn = await (foundDevice as import("react-native-ble-plx").Device).connect();
        log(`Connected. Requesting MTU ${TARGET_MTU}...`);
        conn = await conn.requestMTU(TARGET_MTU);
        log(`MTU negotiated: ${conn.mtu ?? "unknown"}`);
        deviceRef.current = conn;

        setStatus("transferring");
        log("Discovering services & characteristics...");
        conn = await conn.discoverAllServicesAndCharacteristics();

        log("Reading data characteristic (100 bytes)...");
        const dataChar = await conn.readCharacteristicForService(
          BLE_APP_SERVICE_UUID, BLE_DATA_CHAR_UUID
        );
        const rawData = dataChar.value
          ? Buffer.from(dataChar.value, "base64")
          : Buffer.alloc(0);
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

        await conn.cancelConnection();
        log("Disconnected cleanly.");
        setStatus("done");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error: ${msg}`);
        setState((s) => ({ ...s, errorMessage: msg }));
        setStatus("error");
      }
    }, [log, setStatus]);

    // ── Play / Stop / Reset ──────────────────────────────────────────────────────
    const play = useCallback(async () => {
      setState((s) => ({
        ...s, isRunning: true, logs: [],
        sentHash: null, receivedHash: null, errorMessage: null,
      }));

      try {
        const bleOk = await checkBleVersion();
        if (!bleOk) {
          setStatus("ble_unsupported");
          setState((s) => ({ ...s, isRunning: false }));
          return;
        }
        if (state.role === "peripheral") await runAsPeripheral();
        else if (state.role === "central")  await runAsCentral();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Fatal: ${msg}`);
        setState((s) => ({ ...s, errorMessage: msg }));
        setStatus("error");
      }

      setState((s) => ({ ...s, isRunning: false }));
    }, [state.role, checkBleVersion, runAsPeripheral, runAsCentral, log, setStatus]);

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
        sentHash: null, receivedHash: null, errorMessage: null,
      }));
    }, [stop]);

    return { state, setRole, play, stop, reset };
  }