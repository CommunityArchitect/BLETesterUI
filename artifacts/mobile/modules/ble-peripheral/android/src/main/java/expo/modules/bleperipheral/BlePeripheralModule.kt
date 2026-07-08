package expo.modules.bleperipheral

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
  import android.util.Log
  import expo.modules.kotlin.modules.Module
  import expo.modules.kotlin.modules.ModuleDefinition
  import expo.modules.kotlin.Promise
  import java.util.UUID

  class BlePeripheralModule : Module() {

      companion object {
          val SERVICE_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef0")
          val DATA_CHAR_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef1")
          val HASH_CHAR_UUID: UUID = UUID.fromString("12345678-1234-5678-1234-56789abcdef2")
          const val APP_LOCAL_NAME = "BLE5Tester"
          private const val TAG = "BlePeripheral"

          private fun advertiseFailureReason(code: Int): String = when (code) {
              AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "ADVERTISE_FAILED_ALREADY_STARTED"
              AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "ADVERTISE_FAILED_DATA_TOO_LARGE"
              AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "ADVERTISE_FAILED_FEATURE_UNSUPPORTED"
              AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "ADVERTISE_FAILED_INTERNAL_ERROR"
              AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "ADVERTISE_FAILED_TOO_MANY_ADVERTISERS"
              else -> "UNKNOWN_ERROR($code)"
          }
      }

      private var gattServer: BluetoothGattServer? = null
      private var advertiser: BluetoothLeAdvertiser? = null
      private var dataCharacteristic: BluetoothGattCharacteristic? = null
      private var hashCharacteristic: BluetoothGattCharacteristic? = null
      private var advertiseCallback: AdvertiseCallback? = null
      private var payloadBytes: ByteArray = ByteArray(0)
      private var hashBytes: ByteArray = ByteArray(0)

      private val gattServerCallback = object : BluetoothGattServerCallback() {
          override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
              Log.d(TAG, "onConnectionStateChange: device=${device.address} status=$status newState=$newState")
          }

          override fun onCharacteristicReadRequest(
              device: BluetoothDevice,
              requestId: Int,
              offset: Int,
              characteristic: BluetoothGattCharacteristic
          ) {
              Log.d(TAG, "onCharacteristicReadRequest: device=${device.address} uuid=${characteristic.uuid} offset=$offset requestId=$requestId")
              when (characteristic.uuid) {
                  DATA_CHAR_UUID -> {
                      val slice = if (offset < payloadBytes.size)
                          payloadBytes.copyOfRange(offset, payloadBytes.size)
                      else ByteArray(0)
                      Log.d(TAG, "  -> responding with DATA_CHAR slice of ${slice.size} bytes (total ${payloadBytes.size})")
                      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
                  }
                  HASH_CHAR_UUID -> {
                      val slice = if (offset < hashBytes.size)
                          hashBytes.copyOfRange(offset, hashBytes.size)
                      else ByteArray(0)
                      Log.d(TAG, "  -> responding with HASH_CHAR slice of ${slice.size} bytes (total ${hashBytes.size})")
                      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
                  }
                  else -> {
                      Log.w(TAG, "  -> unknown characteristic requested: ${characteristic.uuid}, responding GATT_FAILURE")
                      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                  }
              }
          }
      }

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

                  Log.d(TAG, "Bluetooth adapter found: enabled=${adapter.isEnabled} currentName=${adapter.name}")

                  if (!adapter.isEnabled) {
                      Log.e(TAG, "startServer aborted: Bluetooth is off")
                      return@AsyncFunction promise.reject("ERR_BT_OFF", "Bluetooth is off", null)
                  }

                  payloadBytes = Base64.decode(payloadBase64, Base64.DEFAULT)
                  hashBytes = hashHex.toByteArray(Charsets.UTF_8)
                  Log.d(TAG, "Decoded payload: ${payloadBytes.size} bytes, hash bytes: ${hashBytes.size}")

                  stopInternal()

                  val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

                  dataCharacteristic = BluetoothGattCharacteristic(
                      DATA_CHAR_UUID,
                      BluetoothGattCharacteristic.PROPERTY_READ,
                      BluetoothGattCharacteristic.PERMISSION_READ
                  ).also { service.addCharacteristic(it) }

                  hashCharacteristic = BluetoothGattCharacteristic(
                      HASH_CHAR_UUID,
                      BluetoothGattCharacteristic.PROPERTY_READ,
                      BluetoothGattCharacteristic.PERMISSION_READ
                  ).also { service.addCharacteristic(it) }

                  gattServer = bluetoothManager.openGattServer(context, gattServerCallback)
                  if (gattServer == null) {
                      Log.e(TAG, "openGattServer() returned null")
                      return@AsyncFunction promise.reject("ERR_GATT", "Failed to open GATT server", null)
                  }
                  val serviceAdded = gattServer?.addService(service)
                  Log.d(TAG, "GATT service added=$serviceAdded uuid=$SERVICE_UUID chars=[$DATA_CHAR_UUID, $HASH_CHAR_UUID]")

                  advertiser = adapter.bluetoothLeAdvertiser
                  if (advertiser == null) {
                      Log.e(TAG, "bluetoothLeAdvertiser is null — device may not support BLE peripheral/advertising mode")
                      return@AsyncFunction promise.reject("ERR_ADV", "BLE LE Advertiser not available (device may not support BLE 5 peripheral)", null)
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
                  Log.d(TAG, "Adapter local name set to '$APP_LOCAL_NAME'. Calling startAdvertising() with service UUID $SERVICE_UUID...")

                  val cb = object : AdvertiseCallback() {
                      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                          Log.i(TAG,
                              "✓ Advertising STARTED: mode=${settingsInEffect.mode} txPowerLevel=${settingsInEffect.txPowerLevel} " +
                              "connectable=${settingsInEffect.isConnectable} name='$APP_LOCAL_NAME' service=$SERVICE_UUID")
                          promise.resolve(null)
                      }
                      override fun onStartFailure(errorCode: Int) {
                          val reason = advertiseFailureReason(errorCode)
                          Log.e(TAG, "✗ Advertising FAILED to start: $reason")
                          promise.reject("ERR_ADV_START", "Advertising failed to start: $reason", null)
                      }
                  }
                  advertiseCallback = cb
                  advertiser?.startAdvertising(settings, data, scanResponse, cb)
                  // promise resolved/rejected inside callback above
              } catch (e: Exception) {
                  Log.e(TAG, "startServer() threw exception: ${e.message}", e)
                  promise.reject("ERR_PERIPHERAL", e.message ?: "Unknown error", e)
              }
          }

          AsyncFunction("stopServer") { promise: Promise ->
              Log.i(TAG, "stopServer() called")
              try {
                  stopInternal()
                  promise.resolve(null)
              } catch (e: Exception) {
                  Log.e(TAG, "stopServer() threw exception: ${e.message}", e)
                  promise.reject("ERR_STOP", e.message ?: "Unknown error", e)
              }
          }
      }

      private fun stopInternal() {
          Log.d(TAG, "stopInternal(): stopping advertising and closing GATT server")
          advertiseCallback?.let { advertiser?.stopAdvertising(it) }
          advertiseCallback = null
          advertiser = null
          gattServer?.close()
          gattServer = null
          dataCharacteristic = null
          hashCharacteristic = null
      }
  }
  