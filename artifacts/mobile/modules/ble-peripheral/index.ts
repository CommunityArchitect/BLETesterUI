import { NativeModule, requireNativeModule } from "expo-modules-core";

  export type BlePeripheralModule = {
    startServer(payloadBase64: string, hashHex: string): Promise<void>;
    stopServer(): Promise<void>;
  };

  let mod: BlePeripheralModule | null = null;
  let lastLoadError: string | null = null;

  export function getBlePeripheral(): BlePeripheralModule | null {
    try {
      if (!mod) {
        mod = requireNativeModule("BlePeripheral") as BlePeripheralModule;
      }
      return mod;
    } catch (err: unknown) {
      lastLoadError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  // Exposed so callers can log *why* the native module failed to load
  // (e.g. missing from this build vs. running in Expo Go) instead of just
  // reporting "not found".
  export function getBlePeripheralLoadError(): string | null {
    return lastLoadError;
  }
  