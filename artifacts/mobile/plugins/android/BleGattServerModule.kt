package PLACEHOLDER_PACKAGE

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.UUID

class BleGattServerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef0")
        val DATA_CHAR_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef1")
        val HASH_CHAR_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef2")
        const val APP_LOCAL_NAME = "BLE5Tester"
    }

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var payloadBytes: ByteArray = ByteArray(0)
    private var hashBytes: ByteArray = ByteArray(0)

    override fun getName(): String = "BleGattServer"

    private val gattCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {}

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            val data = when (characteristic.uuid) {
                DATA_CHAR_UUID -> payloadBytes
                HASH_CHAR_UUID -> hashBytes
                else -> null
            }
            if (data != null) {
                val slice = if (offset < data.size) data.copyOfRange(offset, data.size) else ByteArray(0)
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
            }
        }
    }

    @ReactMethod
    fun startServer(payloadBase64: String, hashHex: String, promise: Promise) {
        try {
            val btManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = btManager?.adapter
                ?: return promise.reject("ERR_BT", "Bluetooth adapter not available")

            if (!adapter.isEnabled) {
                return promise.reject("ERR_BT_OFF", "Bluetooth is disabled")
            }

            payloadBytes = Base64.decode(payloadBase64, Base64.DEFAULT)
            hashBytes = hashHex.toByteArray(Charsets.UTF_8)

            stopInternal()

            // Build GATT service
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            service.addCharacteristic(
                BluetoothGattCharacteristic(
                    DATA_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ
                )
            )
            service.addCharacteristic(
                BluetoothGattCharacteristic(
                    HASH_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ,
                    BluetoothGattCharacteristic.PERMISSION_READ
                )
            )

            gattServer = btManager.openGattServer(reactContext, gattCallback)
            gattServer?.addService(service)

            // BLE advertising
            adapter.name = APP_LOCAL_NAME
            advertiser = adapter.bluetoothLeAdvertiser
                ?: return promise.reject("ERR_ADV", "LE Advertiser unavailable — device may not support BLE peripheral mode")

            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build()

            val advData = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()

            val scanResp = AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .build()

            val cb = object : AdvertiseCallback() {
                override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {}
                override fun onStartFailure(errorCode: Int) {}
            }
            advertiseCallback = cb
            advertiser?.startAdvertising(settings, advData, scanResp, cb)

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_START", e.message ?: "Unknown error starting BLE peripheral", e)
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        try {
            stopInternal()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("ERR_STOP", e.message ?: "Unknown error stopping BLE peripheral", e)
        }
    }

    private fun stopInternal() {
        advertiseCallback?.let { advertiser?.stopAdvertising(it) }
        advertiseCallback = null
        advertiser = null
        gattServer?.close()
        gattServer = null
    }
}
