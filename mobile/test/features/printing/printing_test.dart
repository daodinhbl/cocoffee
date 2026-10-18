import 'dart:typed_data';

import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/printing/escpos_raster.dart';
import 'package:cocoffee_mobile/features/printing/printer_service.dart';
import 'package:cocoffee_mobile/features/printing/receipt_image.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

class FakeTransport implements PrinterTransport {
  bool perm = true, on = true, connects = true, writes = true;
  final sent = <Uint8List>[];
  String? connectedTo;
  @override
  Future<bool> permissionGranted() async => perm;
  @override
  Future<bool> bluetoothOn() async => on;
  @override
  Future<List<PrinterDevice>> paired() async => const [PrinterDevice('XP-58', 'AA:BB')];
  @override
  Future<bool> connect(String address) async {
    connectedTo = address;
    return connects;
  }

  @override
  Future<bool> write(Uint8List bytes) async {
    sent.add(bytes);
    return writes;
  }

  @override
  Future<void> disconnect() async {}
}

Map<String, dynamic> receiptJson() => {
      'shop_name': 'Cò Coffee',
      'order': {
        'order_code': 'CF261018-00001', 'created_at': '2026-10-18T03:00:00.000Z', 'subtotal': 70000, 'discount': 5000, 'total': 65000, 'table_name': 'Bàn 2',
        'items': [
          {'product_name': 'Cà phê sữa đá', 'quantity': 2, 'unit_price': 25000, 'line_total': 50000},
          {'product_name': 'Trà đào cam sả', 'quantity': 1, 'unit_price': 20000, 'line_total': 20000, 'note': 'ít đá'},
        ],
      },
      'payments': [{'method': 'cash', 'amount': 65000}],
      'printer': {'shopAddress': '12 Lê Lợi, Huế', 'shopPhone': '0905 123 456', 'footer': 'Cảm ơn quý khách', 'paperMm': 58},
      'vat': 4814.8,
    };

void main() {
  group('escposRaster', () {
    test('header, dimensions and bits: a black pixel becomes a set bit, MSB first', () {
      const w = 16, h = 2;
      final rgba = Uint8List(w * h * 4)..fillRange(0, w * h * 4, 255);
      void black(int x, int y) {
        final i = (y * w + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }

      black(0, 0);
      black(15, 1);
      final out = escposRaster(rgba, w, h, cut: false, feedLines: 0);
      expect(out.sublist(0, 2), [0x1B, 0x40]);
      expect(out.sublist(2, 10), [0x1D, 0x76, 0x30, 0x00, 2, 0, 2, 0], reason: 'GS v 0, 2 bytes per row, 2 rows');
      expect(out.sublist(10), [0x80, 0x00, 0x00, 0x01]);
    });

    test('feeds and cuts; a tall picture is split into blocks of at most 255 rows', () {
      const w = 8, h = 300;
      final out = escposRaster(Uint8List(w * h * 4)..fillRange(0, w * h * 4, 255), w, h);
      expect(out.sublist(2, 10), [0x1D, 0x76, 0x30, 0x00, 1, 0, 255, 0]);
      final second = 2 + 8 + 255;
      expect(out.sublist(second, second + 8), [0x1D, 0x76, 0x30, 0x00, 1, 0, 45, 0]);
      expect(out.sublist(out.length - 4), [0x1D, 0x56, 0x42, 0x00]);
    });

    test('rejects a width that is not a multiple of 8 and a buffer of the wrong size', () {
      expect(() => escposRaster(Uint8List(4 * 7), 7, 1), throwsArgumentError);
      expect(() => escposRaster(Uint8List(10), 8, 1), throwsArgumentError);
    });

    test('paper width to dots', () {
      expect(dotsForPaper(58), 384);
      expect(dotsForPaper(80), 576);
    });
  });

  test('ReceiptData reads the API answer', () {
    final d = ReceiptData.fromJson(receiptJson());
    expect(d.shopName, 'Cò Coffee');
    expect(d.lines.length, 2);
    expect(d.lines.last.note, 'ít đá');
    expect(d.total, 65000);
    expect(d.discount, 5000);
    expect(d.payments.single, 'Tiền mặt: 65.000đ');
    expect(d.address, '12 Lê Lợi, Huế');
    expect(d.vat, closeTo(4814.8, 0.01));
  });

  testWidgets('the receipt is drawn to the paper width, in whole rows of 8 dots', (tester) async {
    await tester.runAsync(() async {
      final image = await paintReceipt(ReceiptData.fromJson(receiptJson()), 384);
      expect(image.width, 384);
      expect(image.height % 8, 0);
      expect(image.height, greaterThan(200));
      final rgba = await rgbaOf(image);
      expect(rgba.length, 384 * image.height * 4);
      var dark = 0;
      for (var i = 0; i < rgba.length; i += 4) {
        if (rgba[i] < 128) dark++;
      }
      expect(dark, greaterThan(500), reason: 'the text was drawn');
      image.dispose();
    });
  });

  group('PrinterService', () {
    late FakeTransport t;
    late MockApi api;
    late ProviderContainer c;

    setUp(() async {
      t = FakeTransport();
      api = MockApi();
      final base = await testContainer(api);
      c = ProviderContainer(overrides: [
        sessionStoreProvider.overrideWithValue(base.read(sessionStoreProvider)),
        apiProvider.overrideWithValue(api),
        printerTransportProvider.overrideWithValue(t),
      ]);
      addTearDown(c.dispose);
    });

    test('no printer chosen: a clear message, nothing sent', () async {
      await expectLater(c.read(printerServiceProvider).printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'message', contains('Chưa chọn máy in'))));
      expect(t.sent, isEmpty);
    });

    testWidgets('prints an order: connects to the saved printer and sends one raster job', (tester) async {
      await tester.runAsync(() async {
        await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('XP-58', 'AA:BB'));
        when(() => api.get('/orders/7/receipt', useCache: false)).thenAnswer((_) async => receiptJson());
        await c.read(printerServiceProvider).printOrder(7);
        expect(t.connectedTo, 'AA:BB');
        expect(t.sent.length, 1);
        expect(t.sent.single.sublist(0, 2), [0x1B, 0x40]);
        expect(t.sent.single.sublist(2, 6), [0x1D, 0x76, 0x30, 0x00]);
        expect(t.sent.single[6], 48, reason: '58 mm paper = 384 dots = 48 bytes per row (paperMm comes from the shop settings)');
      });
    });

    test('Bluetooth off, permission missing, printer unreachable: each has its own message', () async {
      await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('XP-58', 'AA:BB'));
      final svc = c.read(printerServiceProvider);
      t.on = false;
      await expectLater(svc.printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'm', contains('Bluetooth đang tắt'))));
      t.on = true;
      t.perm = false;
      await expectLater(svc.printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'm', contains('quyền Bluetooth'))));
      t.perm = true;
      t.connects = false;
      await expectLater(svc.printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'm', contains('Không kết nối được máy in XP-58'))));
    });

    test('the choice is remembered and can be forgotten', () async {
      expect(c.read(savedPrinterProvider), isNull);
      await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('XP-58', 'AA:BB'));
      expect(c.read(savedPrinterProvider)!.name, 'XP-58');
      await c.read(savedPrinterProvider.notifier).forget();
      expect(c.read(savedPrinterProvider), isNull);
    });
  });
}
