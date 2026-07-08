import { NativeModule, requireNativeModule } from "expo-modules-core";

export type BlePeripheralModule = {
  startServer(payloadBase64: string, hashHex: string): Promise<void>;
  stopServer(): Promise<void>;
};

let mod: BlePeripheralModule | null = null;

export function getBlePeripheral(): BlePeripheralModule | null {
  try {
    if (!mod) {
      mod = requireNativeModule("BlePeripheral") as BlePeripheralModule;
    }
    return mod;
  } catch {
    return null;
  }
}
