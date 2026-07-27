package com.quadreal.insp360.capture;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Dual BLE modes for Insta360 X5.
 * connectCamera() returns immediately (avoids WebView/bridge freeze); progress via bleStatus events.
 */
@CapacitorPlugin(
  name = "InstaBleRemote",
  permissions = {
    @Permission(
      alias = "bluetooth",
      strings = {
        Manifest.permission.BLUETOOTH,
        Manifest.permission.BLUETOOTH_ADMIN,
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_SCAN
      }
    )
  }
)
public class InstaBleRemotePlugin extends Plugin {
  private static final String TAG = "InstaBleRemote";
  private static final long CONNECT_TIMEOUT_MS = 12000;

  private static final UUID SVC_CE80 = uuid16(0xCE80);
  private static final UUID CHAR_CE81 = uuid16(0xCE81);
  private static final UUID CHAR_CE82 = uuid16(0xCE82);
  private static final UUID CHAR_CE83 = uuid16(0xCE83);
  private static final UUID SVC_D0FF = uuid16(0xD0FF);
  private static final UUID CHAR_FFD1 = uuid16(0xFFD1);
  private static final UUID CHAR_FFD2 = uuid16(0xFFD2);
  private static final UUID CHAR_FFD3 = uuid16(0xFFD3);
  private static final UUID CHAR_FFD4 = uuid16(0xFFD4);
  private static final UUID SVC_BE80 = uuid16(0xBE80);
  private static final UUID CHAR_BE81 = uuid16(0xBE81);
  private static final UUID CHAR_BE82 = uuid16(0xBE82);

  private static final byte[] CMD_SHUTTER = new byte[] {
    (byte) 0xFC, (byte) 0xEF, (byte) 0xFE, (byte) 0x86, 0x00, 0x03, 0x01, 0x02, 0x00
  };
  private static final byte[] CMD_WAKE_SCREEN = new byte[] {
    (byte) 0xFC, (byte) 0xEF, (byte) 0xFE, (byte) 0x86, 0x00, 0x03, 0x01, 0x00, 0x00
  };

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Set<BluetoothDevice> remoteClients = new HashSet<>();
  private Runnable timeoutRunnable;

  private BluetoothGattServer gattServer;
  private BluetoothGattCharacteristic ce82;
  private BluetoothLeAdvertiser advertiser;
  private boolean advertising;
  private String lastError = "";
  private String mode = "idle";
  private String cameraName = "";
  private int seq = 1;
  private int connectGen = 0;

  private BluetoothGatt cameraGatt;
  private BluetoothGattCharacteristic be81;
  private boolean cameraReady;
  private String scanFilter = "X5";
  private BluetoothLeScanner scanner;
  private boolean scanning;
  private BluetoothDevice foundDevice;
  private boolean connectInFlight;

  private static UUID uuid16(int shortUuid) {
    String hex = String.format(Locale.US, "%04x", shortUuid & 0xFFFF);
    return UUID.fromString("0000" + hex + "-0000-1000-8000-00805f9b34fb");
  }

  private boolean needPerms(PluginCall call, String callback) {
    if (getPermissionState("bluetooth") != com.getcapacitor.PermissionState.GRANTED) {
      requestPermissionForAlias("bluetooth", call, callback);
      return true;
    }
    return false;
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    JSObject ret = statusObject();
    boolean ok = getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    ret.put("available", ok && adapter != null);
    ret.put("enabled", adapter != null && adapter.isEnabled());
    call.resolve(ret);
  }

  @PluginMethod
  public void start(PluginCall call) {
    if (needPerms(call, "onBlePermsStart")) return;
    startRemote(call);
  }

  @PermissionCallback
  private void onBlePermsStart(PluginCall call) {
    if (getPermissionState("bluetooth") == com.getcapacitor.PermissionState.GRANTED) startRemote(call);
    else call.reject("Bluetooth permission denied");
  }

  /**
   * Starts scan/connect and returns immediately. Listen for bleStatus:
   * scanning | found | camera_ready | connect_fail | stopped
   */
  @PluginMethod
  public void connectCamera(PluginCall call) {
    if (needPerms(call, "onBlePermsConnect")) return;
    String hint = call.getString("nameContains", "X5");
    if (hint == null || hint.trim().isEmpty()) hint = "X5";
    scanFilter = hint.trim();
    beginScanConnectAsync();
    JSObject ret = statusObject();
    ret.put("started", true);
    call.resolve(ret);
  }

  @PermissionCallback
  private void onBlePermsConnect(PluginCall call) {
    if (getPermissionState("bluetooth") == com.getcapacitor.PermissionState.GRANTED) {
      String hint = call.getString("nameContains", "X5");
      if (hint == null || hint.trim().isEmpty()) hint = "X5";
      scanFilter = hint.trim();
      beginScanConnectAsync();
      JSObject ret = statusObject();
      ret.put("started", true);
      call.resolve(ret);
    } else call.reject("Bluetooth permission denied");
  }

  @SuppressLint("MissingPermission")
  private void startRemote(PluginCall call) {
    try {
      BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
      BluetoothAdapter adapter = mgr != null ? mgr.getAdapter() : null;
      if (adapter == null || !adapter.isEnabled()) {
        call.reject("Turn on Bluetooth first");
        return;
      }
      if (adapter.getBluetoothLeAdvertiser() == null) {
        call.reject("This phone cannot advertise BLE");
        return;
      }

      stopInternal(false);

      gattServer = mgr.openGattServer(getContext(), serverCallback);
      if (gattServer == null) {
        call.reject("Could not open GATT server");
        return;
      }

      BluetoothGattService ce80 = new BluetoothGattService(SVC_CE80, BluetoothGattService.SERVICE_TYPE_PRIMARY);
      BluetoothGattCharacteristic ce81 = new BluetoothGattCharacteristic(
        CHAR_CE81,
        BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE
      );
      ce82 = new BluetoothGattCharacteristic(
        CHAR_CE82,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ
      );
      BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(
        UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"),
        BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
      );
      cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
      ce82.addDescriptor(cccd);
      BluetoothGattCharacteristic ce83 = new BluetoothGattCharacteristic(
        CHAR_CE83,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ
      );
      ce83.setValue(new byte[] { 0x02, 0x01 });
      ce80.addCharacteristic(ce81);
      ce80.addCharacteristic(ce82);
      ce80.addCharacteristic(ce83);
      gattServer.addService(ce80);

      BluetoothGattService d0ff = new BluetoothGattService(SVC_D0FF, BluetoothGattService.SERVICE_TYPE_PRIMARY);
      d0ff.addCharacteristic(readChar(CHAR_FFD1, "QR360 Remote"));
      d0ff.addCharacteristic(readChar(CHAR_FFD2, "1.0.0"));
      BluetoothGattCharacteristic ffd3 = readChar(CHAR_FFD3, null);
      ffd3.setValue(new byte[] { 0x30, 0x1e, (byte) 0x90, 0x01 });
      BluetoothGattCharacteristic ffd4 = readChar(CHAR_FFD4, null);
      ffd4.setValue(new byte[] { 0x18, 0x00, 0x20, 0x01 });
      d0ff.addCharacteristic(ffd3);
      d0ff.addCharacteristic(ffd4);
      gattServer.addService(d0ff);

      advertiser = adapter.getBluetoothLeAdvertiser();
      AdvertiseSettings settings = new AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .setTimeout(0)
        .build();
      try { adapter.setName("Insta360 GPS"); } catch (Exception ignored) {}
      AdvertiseData data = new AdvertiseData.Builder()
        .setIncludeDeviceName(true)
        .addServiceUuid(new ParcelUuid(SVC_CE80))
        .build();
      AdvertiseData scanResp = new AdvertiseData.Builder()
        .setIncludeDeviceName(true)
        .build();
      advertiser.startAdvertising(settings, data, scanResp, advertiseCallback);
      advertising = true;
      mode = "remote";
      lastError = "";
      notifyStatus("remote_started");
      call.resolve(statusObject());
    } catch (Exception e) {
      lastError = e.getMessage() != null ? e.getMessage() : String.valueOf(e);
      Log.e(TAG, "startRemote failed", e);
      call.reject(lastError);
    }
  }

  @SuppressLint("MissingPermission")
  private void beginScanConnectAsync() {
    final int gen = ++connectGen;
    try {
      BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
      BluetoothAdapter adapter = mgr != null ? mgr.getAdapter() : null;
      if (adapter == null || !adapter.isEnabled()) {
        failConnect("Turn on Bluetooth first", gen);
        return;
      }

      stopInternal(false);

      foundDevice = null;
      cameraReady = false;
      cameraName = "";
      mode = "camera";
      connectInFlight = true;
      lastError = "Scanning for " + scanFilter + "…";
      notifyStatus("scanning");

      scanner = adapter.getBluetoothLeScanner();
      if (scanner == null) {
        failConnect("BLE scanner unavailable", gen);
        return;
      }

      ScanSettings settings = new ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
        .build();
      scanning = true;
      // Unfiltered scan (name filters are flaky); we match in callback and ignore most results quickly.
      scanner.startScan(null, settings, scanCallback);

      clearTimeout();
      timeoutRunnable = () -> {
        if (gen != connectGen) return;
        if (cameraReady) return;
        stopScan();
        failConnect(
          "Timed out. Forget X5 in phone Bluetooth settings, close Insta360 app, turn camera on, try again.",
          gen
        );
      };
      main.postDelayed(timeoutRunnable, CONNECT_TIMEOUT_MS);
    } catch (Exception e) {
      failConnect(e.getMessage() != null ? e.getMessage() : String.valueOf(e), gen);
    }
  }

  private void failConnect(String msg, int gen) {
    if (gen != connectGen) return;
    connectInFlight = false;
    lastError = msg;
    mode = "idle";
    clearTimeout();
    stopScan();
    notifyStatus("connect_fail");
  }

  private void clearTimeout() {
    if (timeoutRunnable != null) {
      main.removeCallbacks(timeoutRunnable);
      timeoutRunnable = null;
    }
  }

  @SuppressLint("MissingPermission")
  private void stopScan() {
    if (!scanning) return;
    scanning = false;
    try {
      if (scanner != null) scanner.stopScan(scanCallback);
    } catch (Exception ignored) {}
  }

  private final ScanCallback scanCallback = new ScanCallback() {
    @Override
    @SuppressLint("MissingPermission")
    public void onScanResult(int callbackType, ScanResult result) {
      if (!scanning || foundDevice != null || !connectInFlight) return;
      BluetoothDevice d = result.getDevice();
      String name = null;
      try { name = d.getName(); } catch (Exception ignored) {}
      if ((name == null || name.isEmpty()) && result.getScanRecord() != null) {
        name = result.getScanRecord().getDeviceName();
      }
      if (name == null || name.isEmpty()) return;

      String n = name.toUpperCase(Locale.US);
      String f = scanFilter.toUpperCase(Locale.US);
      boolean match =
        n.contains(f)
          || n.startsWith("X5")
          || n.startsWith("X4")
          || n.startsWith("X3")
          || n.contains("INSTA360");
      if (!match) return;
      // If user typed a serial fragment, require it
      if (f.length() >= 5 && !f.equals("X5") && !n.contains(f)) return;

      foundDevice = d;
      cameraName = name;
      lastError = "Found " + name + " — connecting…";
      notifyStatus("found");
      stopScan();
      connectToDevice(d);
    }

    @Override
    public void onScanFailed(int errorCode) {
      scanning = false;
      failConnect("Scan failed code " + errorCode, connectGen);
    }
  };

  @SuppressLint("MissingPermission")
  private void connectToDevice(BluetoothDevice device) {
    try {
      if (cameraGatt != null) {
        try { cameraGatt.close(); } catch (Exception ignored) {}
        cameraGatt = null;
      }
      be81 = null;
      cameraReady = false;
      cameraGatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
    } catch (Exception e) {
      failConnect(e.getMessage() != null ? e.getMessage() : String.valueOf(e), connectGen);
    }
  }

  private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
    @Override
    @SuppressLint("MissingPermission")
    public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        lastError = "GATT connected — discovering…";
        notifyStatus("gatt_connected");
        boolean ok = gatt.discoverServices();
        if (!ok) failConnect("discoverServices failed to start", connectGen);
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        boolean wasReady = cameraReady;
        cameraReady = false;
        be81 = null;
        connectInFlight = false;
        if (!wasReady) {
          failConnect("Camera disconnected during link (status " + status + ")", connectGen);
        } else {
          lastError = "Camera disconnected";
          notifyStatus("camera_disconnected");
        }
      }
    }

    @Override
    @SuppressLint("MissingPermission")
    public void onServicesDiscovered(BluetoothGatt gatt, int status) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        failConnect("Service discovery failed (" + status + ")", connectGen);
        return;
      }
      BluetoothGattService be80 = gatt.getService(SVC_BE80);
      if (be80 != null) {
        be81 = be80.getCharacteristic(CHAR_BE81);
        BluetoothGattCharacteristic be82c = be80.getCharacteristic(CHAR_BE82);
        if (be82c != null) gatt.setCharacteristicNotification(be82c, true);
      }
      if (be81 == null) {
        for (BluetoothGattService s : gatt.getServices()) {
          for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
            int p = c.getProperties();
            if ((p & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
              || (p & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
              be81 = c;
              break;
            }
          }
          if (be81 != null) break;
        }
      }
      if (be81 == null) {
        failConnect("Linked but no command characteristic — try GPS remote mode from X5 menu", connectGen);
        return;
      }
      cameraReady = true;
      connectInFlight = false;
      mode = "camera";
      lastError = "GATT linked — shutter often needs GPS remote mode or camera Wi‑Fi";
      clearTimeout();
      try {
        String n = gatt.getDevice().getName();
        if (n != null && !n.isEmpty()) cameraName = n;
      } catch (Exception ignored) {}
      notifyStatus("camera_ready");
    }
  };

  private BluetoothGattCharacteristic readChar(UUID uuid, String text) {
    BluetoothGattCharacteristic c = new BluetoothGattCharacteristic(
      uuid,
      BluetoothGattCharacteristic.PROPERTY_READ,
      BluetoothGattCharacteristic.PERMISSION_READ
    );
    if (text != null) c.setValue(text.getBytes(StandardCharsets.UTF_8));
    return c;
  }

  @PluginMethod
  public void stop(PluginCall call) {
    connectGen++; // cancel in-flight
    stopInternal(true);
    call.resolve(statusObject());
  }

  @SuppressLint("MissingPermission")
  private void stopInternal(boolean notify) {
    clearTimeout();
    stopScan();
    connectInFlight = false;
    try {
      if (advertiser != null && advertising) advertiser.stopAdvertising(advertiseCallback);
    } catch (Exception ignored) {}
    advertising = false;
    remoteClients.clear();
    try { if (gattServer != null) gattServer.close(); } catch (Exception ignored) {}
    gattServer = null;
    ce82 = null;
    advertiser = null;
    cameraReady = false;
    be81 = null;
    try {
      if (cameraGatt != null) {
        cameraGatt.disconnect();
        cameraGatt.close();
      }
    } catch (Exception ignored) {}
    cameraGatt = null;
    mode = "idle";
    if (notify) {
      lastError = "";
      notifyStatus("stopped");
    }
  }

  @PluginMethod
  public void shutter(PluginCall call) {
    // GPS remote notify is the reliable third-party shutter path
    if (gattServer != null && ce82 != null && !remoteClients.isEmpty()) {
      boolean ok = notifyCommand(CMD_SHUTTER);
      if (ok) {
        JSObject ret = statusObject();
        ret.put("sent", true);
        ret.put("via", "remote");
        call.resolve(ret);
        return;
      }
    }
    // Direct GATT — try several payloads (X5 often ignores TAKE_PICTURE without SDK auth)
    if (cameraReady && be81 != null && cameraGatt != null) {
      String via = writeShutterAttempts();
      if (via != null) {
        JSObject ret = statusObject();
        ret.put("sent", true);
        ret.put("via", via);
        call.resolve(ret);
        return;
      }
      call.reject("Linked over BLE but shutter ignored. Use GPS remote mode, or join X5 Wi‑Fi.");
      return;
    }
    call.reject("Not linked for shutter. Use GPS remote mode, or SNAP+LOG and press camera shutter.");
  }

  @SuppressLint("MissingPermission")
  private String writeShutterAttempts() {
    if (writeRaw(CMD_SHUTTER)) return "camera-gps-bytes";
    if (writeRaw(buildHeader16(0x0003, (byte) 0x02, (byte) 0x80))) return "camera-takePicture";
    if (writeRaw(buildHeader16(0x0003, (byte) 0x00, (byte) 0x80))) return "camera-takePicture-raw";
    if (writeRaw(buildHeader16(0x0003, (byte) 0x02, (byte) 0x00))) return "camera-takePicture-flags0";
    if (writeRaw(buildHeader16(0x0004, (byte) 0x02, (byte) 0x80))) return "camera-startCapture";
    return null;
  }

  @SuppressLint("MissingPermission")
  private boolean writeRaw(byte[] pkt) {
    if (be81 == null || cameraGatt == null || pkt == null) return false;
    try {
      int props = be81.getProperties();
      int writeType = ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
        ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
      if (android.os.Build.VERSION.SDK_INT >= 33) {
        int r = cameraGatt.writeCharacteristic(be81, pkt, writeType);
        return r == BluetoothGatt.GATT_SUCCESS;
      }
      be81.setValue(pkt);
      be81.setWriteType(writeType);
      return cameraGatt.writeCharacteristic(be81);
    } catch (Exception e) {
      Log.w(TAG, "writeRaw failed", e);
      return false;
    }
  }

  private byte[] buildHeader16(int cmd, byte contentType, byte flags) {
    if (seq < 1 || seq > 254) seq = 1;
    byte[] pkt = new byte[16];
    pkt[4] = 0x04;
    pkt[7] = (byte) (cmd & 0xFF);
    pkt[8] = (byte) ((cmd >> 8) & 0xFF);
    pkt[9] = contentType;
    pkt[10] = (byte) seq;
    pkt[13] = flags;
    seq++;
    if (seq > 254) seq = 1;
    return pkt;
  }

  @PluginMethod
  public void wake(PluginCall call) {
    if (gattServer != null && ce82 != null && !remoteClients.isEmpty()) {
      notifyCommand(CMD_WAKE_SCREEN);
      call.resolve(statusObject());
      return;
    }
    call.reject("Wake only works in GPS remote mode");
  }

  @PluginMethod
  public void getStatus(PluginCall call) {
    call.resolve(statusObject());
  }

  @SuppressLint("MissingPermission")
  private boolean notifyCommand(byte[] cmd) {
    if (gattServer == null || ce82 == null) return false;
    ce82.setValue(cmd);
    boolean any = false;
    for (BluetoothDevice d : remoteClients) {
      try {
        any = gattServer.notifyCharacteristicChanged(d, ce82, false) || any;
      } catch (Exception e) {
        Log.w(TAG, "notify failed", e);
      }
    }
    return any;
  }

  private JSObject statusObject() {
    JSObject ret = new JSObject();
    ret.put("mode", mode);
    ret.put("advertising", advertising);
    ret.put("cameraConnected", cameraReady || !remoteClients.isEmpty());
    ret.put("cameraReady", cameraReady);
    ret.put("connectInFlight", connectInFlight);
    ret.put("remoteClients", remoteClients.size());
    ret.put("cameraName", cameraName == null ? "" : cameraName);
    ret.put("scanning", scanning);
    ret.put("clients", remoteClients.size());
    ret.put("lastError", lastError == null ? "" : lastError);
    return ret;
  }

  private void notifyStatus(String event) {
    // Post to main so we never block the BLE binder thread with bridge work.
    main.post(() -> {
      JSObject data = statusObject();
      data.put("event", event);
      notifyListeners("bleStatus", data);
    });
  }

  private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
    @Override
    public void onStartSuccess(AdvertiseSettings settingsInEffect) {
      advertising = true;
      lastError = "";
      notifyStatus("advertise_ok");
    }

    @Override
    public void onStartFailure(int errorCode) {
      advertising = false;
      lastError = "Advertise failed code " + errorCode;
      notifyStatus("advertise_fail");
    }
  };

  private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
    @Override
    public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        remoteClients.add(device);
        notifyStatus("camera_connected");
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        remoteClients.remove(device);
        notifyStatus("camera_disconnected");
      }
    }

    @Override
    @SuppressLint("MissingPermission")
    public void onCharacteristicReadRequest(
      BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic
    ) {
      if (gattServer == null) return;
      byte[] value = characteristic.getValue();
      if (value == null) value = new byte[0];
      if (offset > value.length) {
        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null);
        return;
      }
      byte[] slice = new byte[value.length - offset];
      System.arraycopy(value, offset, slice, 0, slice.length);
      gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice);
    }

    @Override
    @SuppressLint("MissingPermission")
    public void onCharacteristicWriteRequest(
      BluetoothDevice device,
      int requestId,
      BluetoothGattCharacteristic characteristic,
      boolean preparedWrite,
      boolean responseNeeded,
      int offset,
      byte[] value
    ) {
      if (responseNeeded && gattServer != null) {
        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
      }
    }

    @Override
    @SuppressLint("MissingPermission")
    public void onDescriptorWriteRequest(
      BluetoothDevice device,
      int requestId,
      BluetoothGattDescriptor descriptor,
      boolean preparedWrite,
      boolean responseNeeded,
      int offset,
      byte[] value
    ) {
      if (responseNeeded && gattServer != null) {
        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
      }
    }
  };

  @Override
  protected void handleOnDestroy() {
    connectGen++;
    stopInternal(false);
    super.handleOnDestroy();
  }
}
