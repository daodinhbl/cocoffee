import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/printing/lan_printer.dart';
import 'package:cocoffee_mobile/features/printing/printer_service.dart';
import 'package:cocoffee_mobile/features/printing/printer_settings_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../helpers/test_app.dart';
import 'printing_test.dart' show FakeTransport;

void main() {
  group('LanAddress.parse', () {
    test('host, optional port (default 9100), IPv4 range and names', () {
      expect(LanAddress.parse('192.168.1.50').toString(), '192.168.1.50:9100');
      expect(LanAddress.parse(' 192.168.1.50:9101 ').toString(), '192.168.1.50:9101');
      expect(LanAddress.parse('may-in-quay.local')!.port, 9100);
      for (final bad in ['', '   ', '192.168.1.300', '192.168.1.5:0', '192.168.1.5:99999', '192.168.1.5:abc', 'khong hop le', '-x']) {
        expect(LanAddress.parse(bad), isNull, reason: bad);
      }
    });
  });

  group('scanLan', () {
    test('tries .1 to .254 once each, reports the hosts that answer, sorted numerically', () async {
      final tried = <String>[];
      final found = <String>[];
      final hosts = await scanLan('192.168.7', connector: (h, p, t) async {
        tried.add('$h:$p');
        return h == '192.168.7.200' || h == '192.168.7.9' || h == '192.168.7.50';
      }, onFound: found.add);
      expect(hosts, ['192.168.7.9', '192.168.7.50', '192.168.7.200']);
      expect(tried.length, 254);
      expect(tried.toSet().length, 254);
      expect(tried.every((e) => e.endsWith(':9100')), isTrue);
      expect(found.toSet(), hosts.toSet());
    });

    test('nothing answers: an empty list', () async {
      expect(await scanLan('10.0.0', connector: (h, p, t) async => false), isEmpty);
    });
  });

  test('LanTransport really writes the bytes to a TCP port (a printer on 9100 is just that)', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    final received = Completer<List<int>>();
    server.listen((s) async {
      final data = <int>[];
      await for (final chunk in s) {
        data.addAll(chunk);
      }
      if (data.isNotEmpty && !received.isCompleted) received.complete(data);   // the connect() probe opens and closes without data
    });
    final t = LanTransport();
    expect(await t.connect('127.0.0.1:${server.port}'), isTrue);
    expect(await t.write(Uint8List.fromList([0x1B, 0x40, 1, 2, 3])), isTrue);
    expect(await received.future.timeout(const Duration(seconds: 5)), [0x1B, 0x40, 1, 2, 3]);
    expect(await LanTransport().connect('127.0.0.1:1'), isFalse, reason: 'nothing listens there');
    expect(await LanTransport().connect('khong hop le'), isFalse);
  });

  group('the app sends to the saved printer by its kind', () {
    late ProviderContainer c;
    late FakeTransport bluetooth, lan;

    setUp(() async {
      bluetooth = FakeTransport();
      lan = FakeTransport();
      final base = await testContainer(MockApi());
      c = ProviderContainer(overrides: [
        sessionStoreProvider.overrideWithValue(base.read(sessionStoreProvider)),
        printerTransportProvider.overrideWithValue(bluetooth),
        lanTransportProvider.overrideWithValue(lan),
      ]);
      addTearDown(c.dispose);
    });

    testWidgets('a LAN printer: no Bluetooth checks, one raster job to host:port, remembered with its kind', (tester) async {
      await tester.runAsync(() async {
        await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('Quầy', '192.168.1.50:9100'), kind: kindLan);
        expect(c.read(savedPrinterProvider)!.isLan, isTrue);
        bluetooth.on = false; // would fail a Bluetooth print
        await c.read(printerServiceProvider).printTest(paperMm: 58);
        expect(lan.connectedTo, '192.168.1.50:9100');
        expect(lan.sent.length, 1);
        expect(bluetooth.sent, isEmpty);
        expect(lan.sent.single.sublist(2, 6), [0x1D, 0x76, 0x30, 0x00]);
        expect(lan.sent.single[6], 48);
      });
    });

    test('a LAN printer that does not answer: a message about the network, not Bluetooth', () async {
      await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('Quầy', '192.168.1.50:9100'), kind: kindLan);
      lan.connects = false;
      await expectLater(c.read(printerServiceProvider).printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'm', allOf(contains('Wi-Fi/LAN'), contains('192.168.1.50:9100')))));
    });

    test('a Bluetooth printer still goes through Bluetooth and its checks', () async {
      await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('XP-58', 'AA:BB'));
      expect(c.read(savedPrinterProvider)!.kind, kindBluetooth);
      bluetooth.on = false;
      await expectLater(c.read(printerServiceProvider).printTest(), throwsA(isA<PrintException>().having((e) => e.message, 'm', contains('Bluetooth đang tắt'))));
      expect(lan.connectedTo, isNull);
    });

    test('the kind survives a restart', () async {
      await c.read(savedPrinterProvider.notifier).choose(const PrinterDevice('Quầy', '192.168.1.50:9100'), kind: kindLan);
      final again = ProviderContainer(overrides: [sessionStoreProvider.overrideWithValue(c.read(sessionStoreProvider))]);
      addTearDown(again.dispose);
      final s = again.read(savedPrinterProvider)!;
      expect(s.isLan, isTrue);
      expect(s.address, '192.168.1.50:9100');
    });
  });

  group('LanPrinterDialog', () {
    Future<PrinterDevice?> run(WidgetTester tester, {required LanConnector connector, Future<String?> Function()? subnet}) async {
      await setSurface(tester, phone);
      PrinterDevice? result;
      await tester.pumpWidget(await testApp(
        Builder(builder: (context) => Scaffold(body: Center(child: FilledButton(
          onPressed: () async => result = await showDialog<PrinterDevice>(context: context, builder: (_) => LanPrinterDialog(connector: connector, subnetFinder: subnet ?? () async => '192.168.1')),
          child: const Text('mở'),
        )))),
        api: MockApi(),
      ));
      await tester.tap(find.text('mở'));
      await tester.pumpAndSettle();
      return result;
    }

    testWidgets('type an address: it is tried, then added with a default name', (tester) async {
      final tried = <String>[];
      await run(tester, connector: (h, p, t) async {
        tried.add('$h:$p');
        return true;
      });
      await tester.enterText(find.byType(TextField).first, '192.168.1.50');
      await tester.tap(find.text('Thêm'));
      await tester.pumpAndSettle();
      expect(tried, ['192.168.1.50:9100']);
      expect(find.text('Thêm máy in mạng LAN'), findsNothing, reason: 'the dialog closed with the printer');
    });

    testWidgets('a bad address and an unreachable one are explained, the dialog stays open', (tester) async {
      await run(tester, connector: (h, p, t) async => false);
      await tester.enterText(find.byType(TextField).first, 'khong hop le');
      await tester.tap(find.text('Thêm'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Địa chỉ không hợp lệ'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, '192.168.1.99');
      await tester.tap(find.text('Thêm'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Không kết nối được 192.168.1.99:9100'), findsOneWidget);
      expect(find.text('Thêm máy in mạng LAN'), findsOneWidget);
    });

    testWidgets('search finds printers on this Wi-Fi and tapping one fills the address', (tester) async {
      await run(tester, connector: (h, p, t) async => h == '192.168.1.77');
      await tester.tap(find.byKey(const Key('scan-lan')));
      await tester.pumpAndSettle();
      expect(find.text('192.168.1.77'), findsOneWidget);
      await tester.tap(find.text('192.168.1.77'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField).first).controller!.text, '192.168.1.77');
    });

    testWidgets('no Wi-Fi: the search says so instead of scanning', (tester) async {
      var scanned = false;
      await run(tester, connector: (h, p, t) async {
        scanned = true;
        return false;
      }, subnet: () async => null);
      await tester.tap(find.byKey(const Key('scan-lan')));
      await tester.pumpAndSettle();
      expect(scanned, isFalse);
      expect(find.textContaining('chưa nối Wi-Fi/LAN'), findsOneWidget);
    });
  });
}
