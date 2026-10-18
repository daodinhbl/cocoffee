import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';

import '../../core/api/api_client.dart';
import '../../core/diagnostics/app_log.dart';
import '../../core/session.dart';
import 'escpos_raster.dart';
import 'receipt_image.dart';

/// A paired Bluetooth printer as the phone lists it.
class PrinterDevice {
  const PrinterDevice(this.name, this.address);
  final String name, address;
}

/// Where the bytes go. The real one is Bluetooth; tests plug in a fake.
abstract class PrinterTransport {
  Future<bool> permissionGranted();
  Future<bool> bluetoothOn();
  Future<List<PrinterDevice>> paired();
  Future<bool> connect(String address);
  Future<bool> write(Uint8List bytes);
  Future<void> disconnect();
}

class BluetoothThermalTransport implements PrinterTransport {
  @override
  Future<bool> permissionGranted() => PrintBluetoothThermal.isPermissionBluetoothGranted;
  @override
  Future<bool> bluetoothOn() => PrintBluetoothThermal.bluetoothEnabled;
  @override
  Future<List<PrinterDevice>> paired() async => [for (final b in await PrintBluetoothThermal.pairedBluetooths) PrinterDevice(b.name, b.macAdress)];
  @override
  Future<bool> connect(String address) => PrintBluetoothThermal.connect(macPrinterAddress: address);
  @override
  Future<bool> write(Uint8List bytes) => PrintBluetoothThermal.writeBytes(bytes);
  @override
  Future<void> disconnect() async {
    await PrintBluetoothThermal.disconnect;
  }
}

final printerTransportProvider = Provider<PrinterTransport>((_) => BluetoothThermalTransport());

const _kName = 'printer.bt.name';
const _kAddress = 'printer.bt.address';

/// The Bluetooth printer the shop chose on this phone (stored locally: each phone pairs its own printer).
class SavedPrinter {
  const SavedPrinter(this.name, this.address);
  final String name, address;
}

class SavedPrinterNotifier extends Notifier<SavedPrinter?> {
  @override
  SavedPrinter? build() {
    final p = ref.watch(sessionStoreProvider).prefs;
    final a = p.getString(_kAddress);
    return a == null ? null : SavedPrinter(p.getString(_kName) ?? a, a);
  }

  Future<void> choose(PrinterDevice d) async {
    final p = ref.read(sessionStoreProvider).prefs;
    await p.setString(_kName, d.name);
    await p.setString(_kAddress, d.address);
    state = SavedPrinter(d.name, d.address);
  }

  Future<void> forget() async {
    final p = ref.read(sessionStoreProvider).prefs;
    await p.remove(_kName);
    await p.remove(_kAddress);
    state = null;
  }
}

final savedPrinterProvider = NotifierProvider<SavedPrinterNotifier, SavedPrinter?>(SavedPrinterNotifier.new);

class PrintException implements Exception {
  PrintException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Prints a receipt on the saved Bluetooth printer.
class PrinterService {
  PrinterService(this._ref);
  final Ref _ref;

  PrinterTransport get _t => _ref.read(printerTransportProvider);

  Future<void> _ensureConnected() async {
    final saved = _ref.read(savedPrinterProvider);
    if (saved == null) throw PrintException('Chưa chọn máy in. Vào Cài đặt > Máy in Bluetooth để chọn.');
    if (!await _t.permissionGranted()) throw PrintException('Chưa cấp quyền Bluetooth cho ứng dụng.');
    if (!await _t.bluetoothOn()) throw PrintException('Bluetooth đang tắt. Hãy bật Bluetooth rồi in lại.');
    if (!await _t.connect(saved.address)) throw PrintException('Không kết nối được máy in ${saved.name}. Kiểm tra máy in đã bật và đang ở gần.');
  }

  Future<void> _send(Uint8List bytes) async {
    await _ensureConnected();
    if (!await _t.write(bytes)) {
      AppLog.instance.record('warn', 'In: máy in từ chối dữ liệu');
      throw PrintException('Máy in không nhận dữ liệu. Thử in lại.');
    }
  }

  /// Fetches the receipt data of an order and prints it.
  Future<void> printOrder(int orderId, {int? paperMm}) async {
    final res = await _ref.read(apiProvider).get('/orders/$orderId/receipt', useCache: false);
    final data = ReceiptData.fromJson(res);
    final printer = res['printer'] is Map ? res['printer'] as Map : const {};
    final mm = paperMm ?? (printer['paperMm'] is num ? (printer['paperMm'] as num).toInt() : 80);
    await printData(data, paperMm: mm);
  }

  Future<void> printData(ReceiptData data, {int paperMm = 80}) async {
    final width = dotsForPaper(paperMm);
    final image = await paintReceipt(data, width);
    final rgba = await rgbaOf(image);
    final bytes = escposRaster(rgba, width, image.height);
    image.dispose();
    await _send(bytes);
  }

  /// A short test page.
  Future<void> printTest({int paperMm = 80}) => printData(
        const ReceiptData(
          shopName: 'Thử in', code: 'TEST-0001', time: '', lines: [ReceiptLine('Cà phê sữa đá', 2, 25000, 50000, null)], subtotal: 50000, discount: 0, total: 50000,
          payments: ['Tiền mặt: 50.000đ'], footer: 'Tiếng Việt có dấu in đúng là máy in đã sẵn sàng.',
        ),
        paperMm: paperMm,
      );

  Future<List<PrinterDevice>> paired() async {
    if (!await _t.permissionGranted()) throw PrintException('Chưa cấp quyền Bluetooth cho ứng dụng.');
    if (!await _t.bluetoothOn()) throw PrintException('Bluetooth đang tắt.');
    return _t.paired();
  }
}

final printerServiceProvider = Provider<PrinterService>(PrinterService.new);

/// "Chưa có mạng" and the like reach the caller as ApiException; anything printing-specific as PrintException.
String printErrorText(Object e) => e is PrintException ? e.message : toApiException(e).message;
