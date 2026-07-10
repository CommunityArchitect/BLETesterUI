package expo.modules.bleperipheral

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.util.UUID
import java.util.concurrent.Semaphore

class BlePeripheralModule : Module() {

    companion object {
        val SERVICE_UUID: UUID         = UUID.fromString("12345678-1234-5678-1234-56789abcdef0")
        val DATA_CHAR_UUID: UUID       = UUID.fromString("12345678-1234-5678-1234-56789abcdef1")
        val HASH_CHAR_UUID: UUID       = UUID.fromString("12345678-1234-5678-1234-56789abcdef2")
        // TC2: notify-based stream characteristic
        val DATA_TC2_STREAM_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef3")
        // Standard CCCD UUID (Client Characteristic Configuration Descriptor)
        val CCCD_UUID: UUID            = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        const val APP_LOCAL_NAME = "BLE5Tester"
        const val TAG = "BlePeripheral"

        @Volatile private var crashLoggerInstalled = false

        // Installs a process-wide uncaught exception logger exactly once. Any thread
        // (main, binder callback thread, or our streaming daemon thread) that dies with
        // an uncaught exception will log a clearly-tagged "FATAL" line under TAG before
        // the previous (default) handler runs and the process actually terminates.
        // Filter with: adb logcat -s BlePeripheral:V AndroidRuntime:E DEBUG:E
        fun installCrashLoggerOnce() {
            if (crashLoggerInstalled) return
            synchronized(this) {
                if (crashLoggerInstalled) return
                val previous = Thread.getDefaultUncaughtExceptionHandler()
                Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                    Log.e(
                        TAG,
                        "############## FATAL UNCAUGHT EXCEPTION ##############\n" +
                        "thread=\"${thread.name}\" (id=${thread.id})\n" +
                        "exception=${throwable.javaClass.name}: ${throwable.message}",
                        throwable
                    )
                    Log.e(TAG, "############## END FATAL EXCEPTION — process will now terminate ##############")
                    previous?.uncaughtException(thread, throwable)
                }
                crashLoggerInstalled = true
                Log.i(TAG, "installCrashLoggerOnce(): global uncaught-exception logger installed")
            }
        }

        private fun advertiseFailureReason(code: Int): String = when (code) {
            AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED   -> "ADVERTISE_FAILED_ALREADY_STARTED"
            AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE    -> "ADVERTISE_FAILED_DATA_TOO_LARGE"
            AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "ADVERTISE_FAILED_FEATURE_UNSUPPORTED"
            AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR    -> "ADVERTISE_FAILED_INTERNAL_ERROR"
            AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "ADVERTISE_FAILED_TOO_MANY_ADVERTISERS"
            else -> "UNKNOWN_ERROR($code)"
        }
    }

    init {
        installCrashLoggerOnce()
    }

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var dataCharacteristic: BluetoothGattCharacteristic? = null
    private var hashCharacteristic: BluetoothGattCharacteristic? = null
    private var streamCharacteristic: BluetoothGattCharacteristic? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var payloadBytes: ByteArray = ByteArray(0)
    private var hashBytes: ByteArray = ByteArray(0)
    private var connectedDevice: BluetoothDevice? = null
    private var negotiatedMtu: Int = 23
    private var streamThread: Thread? = null
    // Pipeline depth: how many notifications can be in flight (queued in the
    // controller) before streamPayload() blocks waiting for onNotificationSent.
    // With a permit count of 1 (stop-and-wait), throughput is capped at
    // roughly one chunk per connection interval — at BALANCED priority
    // (~30-50ms interval) that's only ~10-17 KB/s regardless of MTU/chunk size.
    // Raising this lets the controller keep several notifications queued so
    // the radio can send back-to-back within a single connection interval.
    private val NOTIFY_PIPELINE_DEPTH = 4
    private var notifySemaphore = Semaphore(NOTIFY_PIPELINE_DEPTH)

    // ── Streaming: send payloadBytes in MTU-sized chunks via NOTIFY ──────────────
    // Runs on a dedicated daemon thread. Wrapped in try/catch/finally so that any
    // exception is fully logged under TAG (with thread name + stack) before it is
    // rethrown — the global crash logger installed in the companion object will also
    // catch it, but logging here first pinpoints exactly which offset/chunk failed.
    private fun streamPayload(device: BluetoothDevice) {
        Log.i(TAG, "streamPayload: thread started, name=${Thread.currentThread().name}")
        try {
            val streamChar = streamCharacteristic ?: run {
                Log.e(TAG, "streamPayload: streamCharacteristic is null, aborting")
                return
            }
            // ATT spec caps a single attribute value at 512 bytes regardless of MTU
            // (BLUETOOTH_MAX_ATTR_LEN). At high MTUs (e.g. 517) mtu-3 exceeds that cap
            // and notifyCharacteristicChanged() throws IllegalArgumentException.
            val chunkSize = maxOf(1, minOf(negotiatedMtu - 3, 512))
            val total = payloadBytes.size
            var offset = 0
            var chunkIndex = 0
            Log.i(TAG, "streamPayload: starting — total=$total bytes, chunkSize=$chunkSize (MTU=$negotiatedMtu) device=${device.address}")

            while (offset < total && !Thread.currentThread().isInterrupted) {
                val end = minOf(offset + chunkSize, total)
                val chunk = payloadBytes.copyOfRange(offset, end)
                streamChar.value = chunk

                // Acquire before sending: blocks until previous notification was delivered.
                try {
                    notifySemaphore.acquire()
                } catch (e: InterruptedException) {
                    Log.d(TAG, "streamPayload interrupted during acquire at offset=$offset")
                    break
                }

                if (gattServer == null) {
                    Log.e(TAG, "streamPayload: gattServer became null mid-stream at offset=$offset, aborting")
                    break
                }

                val queued = try {
                    gattServer?.notifyCharacteristicChanged(device, streamChar, false) ?: false
                } catch (e: Throwable) {
                    Log.e(TAG, "streamPayload: notifyCharacteristicChanged THREW at offset=$offset chunkIndex=$chunkIndex chunkLen=${chunk.size}: ${e.javaClass.simpleName}: ${e.message}", e)
                    throw e
                }
                if (!queued) {
                    // Notification not queued (TX buffer full); return permit and retry.
                    notifySemaphore.release()
                    Log.d(TAG, "streamPayload: notifyCharacteristicChanged returned false at offset=$offset, retrying after 10ms")
                    try { Thread.sleep(10) } catch (e: InterruptedException) { break }
                    continue
                }
                // Only advance offset on successful queue.
                chunkIndex++
                if (chunkIndex % 50 == 0 || end == total || chunkIndex <= 3) {
                    Log.d(TAG, "streamPayload: sent chunk #$chunkIndex offset=$offset/$total (${end * 100 / total}%) chunkLen=${chunk.size}")
                }
                offset = end
            }
            Log.i(TAG, "streamPayload: finished — sent $offset/$total bytes in $chunkIndex chunks")
        } catch (t: Throwable) {
            Log.e(TAG, "streamPayload: UNCAUGHT ${t.javaClass.name} on thread=${Thread.currentThread().name}: ${t.message}", t)
            throw t
        } finally {
            Log.i(TAG, "streamPayload: thread exiting, name=${Thread.currentThread().name}")
        }
    }

    // ── GATT Server Callbacks ────────────────────────────────────────────────────
    // Every override is wrapped in try/catch(Throwable) so that any exception thrown
    // while Android's Bluetooth stack invokes us (these run on a Binder callback
    // thread, not our own code) is fully logged under TAG — with method name, all
    // relevant args, and a full stack trace — before being rethrown. Without this,
    // an exception here can otherwise surface only as a generic system-level crash
    // with little indication of which callback or characteristic/descriptor was involved.
    private inline fun guarded(method: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "CRASH in $method() on thread=${Thread.currentThread().name}: ${t.javaClass.name}: ${t.message}", t)
            throw t
        }
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) = guarded("onConnectionStateChange") {
            Log.d(TAG, "onConnectionStateChange: device=${device.address} status=$status newState=$newState")
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    connectedDevice = device
                    Log.i(TAG, "Central connected: ${device.address}")
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    if (connectedDevice?.address == device.address) connectedDevice = null
                    streamThread?.interrupt()
                    streamThread = null
                    Log.i(TAG, "Central disconnected: ${device.address}")
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) = guarded("onMtuChanged") {
            Log.i(TAG, "onMtuChanged: device=${device.address} mtu=$mtu")
            negotiatedMtu = mtu
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) = guarded("onNotificationSent") {
            Log.d(TAG, "onNotificationSent: device=${device.address} status=$status")
            // Release permit so the streaming thread can send the next chunk.
            notifySemaphore.release()
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) = guarded("onCharacteristicReadRequest") {
            Log.d(TAG, "onCharacteristicReadRequest: device=${device.address} uuid=${characteristic.uuid} offset=$offset")
            when (characteristic.uuid) {
                DATA_CHAR_UUID -> {
                    val slice = if (offset < payloadBytes.size)
                        payloadBytes.copyOfRange(offset, payloadBytes.size)
                    else ByteArray(0)
                    Log.d(TAG, "  -> DATA_CHAR: responding with ${slice.size} bytes (total ${payloadBytes.size})")
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
                }
                HASH_CHAR_UUID -> {
                    val slice = if (offset < hashBytes.size)
                        hashBytes.copyOfRange(offset, hashBytes.size)
                    else ByteArray(0)
                    Log.d(TAG, "  -> HASH_CHAR: responding with ${slice.size} bytes")
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
                }
                else -> {
                    Log.w(TAG, "  -> unknown characteristic: ${characteristic.uuid}, sending GATT_FAILURE")
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                }
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) = guarded("onDescriptorWriteRequest") {
            Log.d(TAG, "onDescriptorWriteRequest: device=${device.address} descriptor=${descriptor.uuid} char=${descriptor.characteristic?.uuid} value=${value?.contentToString()} preparedWrite=$preparedWrite responseNeeded=$responseNeeded")
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            if (descriptor.uuid == CCCD_UUID &&
                value != null &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            ) {
                Log.i(TAG, "Central enabled notifications for ${descriptor.characteristic?.uuid} — starting stream to ${device.address}")
                // Reset semaphore to exactly 1 permit for fresh streaming session.
                notifySemaphore.drainPermits()
                notifySemaphore.release()
                streamThread?.interrupt()
                Log.d(TAG, "onDescriptorWriteRequest: spawning stream thread for ${device.address}")
                streamThread = Thread {
                    guarded("streamThread") { streamPayload(device) }
                }.also { it.isDaemon = true; it.start() }
                Log.d(TAG, "onDescriptorWriteRequest: stream thread started, id=${streamThread?.id}")
            } else if (descriptor.uuid == CCCD_UUID &&
                value != null &&
                value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
            ) {
                Log.i(TAG, "Central disabled notifications — stopping stream")
                streamThread?.interrupt()
                streamThread = null
            }
        }
    }

    // ── Expo Module Definition ───────────────────────────────────────────────────
    override fun definition() = ModuleDefinition {
        Name("BlePeripheral")

        AsyncFunction("startServer") { payloadBase64: String, hashHex: String, promise: Promise ->
            Log.i(TAG, "startServer() called: payloadBase64.len=${payloadBase64.length} hash=$hashHex")
            try {
                val context = appContext.reactContext
                    ?: return@AsyncFunction promise.reject("ERR_NO_CONTEXT", "No React context", null)

                val bluetoothManager =
                    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                val adapter = bluetoothManager?.adapter
                    ?: return@AsyncFunction promise.reject("ERR_BT", "Bluetooth adapter not available", null)

                Log.d(TAG, "Bluetooth adapter: enabled=${adapter.isEnabled} name=${adapter.name}")

                if (!adapter.isEnabled) {
                    Log.e(TAG, "startServer aborted: Bluetooth is off")
                    return@AsyncFunction promise.reject("ERR_BT_OFF", "Bluetooth is off", null)
                }

                payloadBytes = Base64.decode(payloadBase64, Base64.DEFAULT)
                hashBytes = hashHex.toByteArray(Charsets.UTF_8)
                Log.d(TAG, "Decoded payload: ${payloadBytes.size} bytes, hash: ${hashBytes.size} chars")

                stopInternal()

                // ── Build GATT service with all characteristics ───────────────
                val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

                // TC1: plain READ data characteristic
                dataCharacteristic = BluetoothGattCharacteristic(
                    DATA_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ
                ).also { service.addCharacteristic(it) }

                // Shared hash characteristic (READ)
                hashCharacteristic = BluetoothGattCharacteristic(
                    HASH_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ
                ).also { service.addCharacteristic(it) }

                // TC2: NOTIFY stream characteristic + CCCD descriptor
                streamCharacteristic = BluetoothGattCharacteristic(
                    DATA_TC2_STREAM_UUID,
                    BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    0  // no direct READ permission; data delivered via NOTIFY
                ).also { streamChar ->
                    val cccd = BluetoothGattDescriptor(
                        CCCD_UUID,
                        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
                    )
                    cccd.value = BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                    streamChar.addDescriptor(cccd)
                    service.addCharacteristic(streamChar)
                }

                gattServer = bluetoothManager.openGattServer(context, gattServerCallback)
                if (gattServer == null) {
                    Log.e(TAG, "openGattServer() returned null")
                    return@AsyncFunction promise.reject("ERR_GATT", "Failed to open GATT server", null)
                }
                val serviceAdded = gattServer?.addService(service) ?: false
                Log.i(TAG, "GATT service addService()=$serviceAdded for $SERVICE_UUID with DATA(${DATA_CHAR_UUID}), HASH(${HASH_CHAR_UUID}), STREAM(${DATA_TC2_STREAM_UUID}) chars")
                if (!serviceAdded) {
                    Log.e(TAG, "addService() returned false — service was not registered")
                    return@AsyncFunction promise.reject("ERR_GATT", "Failed to add GATT service", null)
                }

                // ── Start advertising ─────────────────────────────────────────
                advertiser = adapter.bluetoothLeAdvertiser
                if (advertiser == null) {
                    Log.e(TAG, "bluetoothLeAdvertiser is null — device may not support BLE peripheral mode")
                    return@AsyncFunction promise.reject("ERR_ADV", "BLE LE Advertiser not available", null)
                }

                val settings = AdvertiseSettings.Builder()
                    .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                    .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                    .setConnectable(true)
                    .setTimeout(0)
                    .build()

                val data = AdvertiseData.Builder()
                    .setIncludeDeviceName(false)
                    .addServiceUuid(ParcelUuid(SERVICE_UUID))
                    .build()

                val scanResponse = AdvertiseData.Builder()
                    .setIncludeDeviceName(true)
                    .build()

                adapter.name = APP_LOCAL_NAME
                Log.d(TAG, "Set adapter name='$APP_LOCAL_NAME', calling startAdvertising()...")

                val cb = object : AdvertiseCallback() {
                    override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                        Log.i(TAG,
                            "✓ Advertising STARTED: mode=${settingsInEffect.mode} " +
                            "txPower=${settingsInEffect.txPowerLevel} " +
                            "connectable=${settingsInEffect.isConnectable} " +
                            "name='$APP_LOCAL_NAME' service=$SERVICE_UUID"
                        )
                        promise.resolve(null)
                    }
                    override fun onStartFailure(errorCode: Int) {
                        val reason = advertiseFailureReason(errorCode)
                        Log.e(TAG, "✗ Advertising FAILED: $reason")
                        promise.reject("ERR_ADV_START", "Advertising failed: $reason", null)
                    }
                }
                advertiseCallback = cb
                advertiser?.startAdvertising(settings, data, scanResponse, cb)
                // Promise resolved/rejected inside callback above.

            } catch (t: Throwable) {
                Log.e(TAG, "startServer() THREW: ${t.javaClass.name}: ${t.message}", t)
                promise.reject("ERR_PERIPHERAL", t.message ?: "Unknown error", t)
            }
        }

        AsyncFunction("stopServer") { promise: Promise ->
            Log.i(TAG, "stopServer() called")
            try {
                stopInternal()
                promise.resolve(null)
            } catch (t: Throwable) {
                Log.e(TAG, "stopServer() THREW: ${t.javaClass.name}: ${t.message}", t)
                promise.reject("ERR_STOP", t.message ?: "Unknown error", t)
            }
        }
    }

    private fun stopInternal() {
        Log.d(TAG, "stopInternal(): stopping stream, advertising, and GATT server")
        streamThread?.interrupt()
        streamThread = null
        advertiseCallback?.let { advertiser?.stopAdvertising(it) }
        advertiseCallback = null
        advertiser = null
        gattServer?.close()
        gattServer = null
        dataCharacteristic = null
        hashCharacteristic = null
        streamCharacteristic = null
        connectedDevice = null
        negotiatedMtu = 23
        // Reset semaphore for next session.
        notifySemaphore.drainPermits()
        notifySemaphore.release()
    }
}
