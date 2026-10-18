import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'printer_service.dart';

/// Network (LAN / Wi-Fi) thermal printers speak raw ESC/POS on TCP port 9100 ("JetDirect"). [address] is "host:port".
class LanAddress {
  const LanAddress(this.host, this.port);
  final String host;
  final int port;

  /// "192.168.1.50" or "192.168.1.50:9100"; null when it is not a usable host / port.
  static LanAddress? parse(String raw, {int defaultPort = 9100}) {
    final t = raw.trim();
    if (t.isEmpty) return null;
    final i = t.lastIndexOf(':');
    final host = i > 0 ? t.substring(0, i) : t;
    final port = i > 0 ? int.tryParse(t.substring(i + 1)) : defaultPort;
    if (port == null || port < 1 || port > 65535) return null;
    final isIp = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$').firstMatch(host);
    if (isIp != null) {
      if ([1, 2, 3, 4].any((g) => int.parse(isIp.group(g)!) > 255)) return null;
    } else if (!RegExp(r'^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$').hasMatch(host)) {
      return null;
    }
    return LanAddress(host, port);
  }

  @override
  String toString() => '$host:$port';
}

/// Opens a TCP connection and returns whether it succeeded; tests plug in a fake.
typedef LanConnector = Future<bool> Function(String host, int port, Duration timeout);

Future<bool> realConnector(String host, int port, Duration timeout) async {
  try {
    final s = await Socket.connect(host, port, timeout: timeout);
    s.destroy();
    return true;
  } catch (_) {
    return false;
  }
}

/// Sends the receipt to a network printer: connect, write, flush, close, every time (these printers drop idle connections).
class LanTransport implements PrinterTransport {
  LanTransport({this.timeout = const Duration(seconds: 4)});
  final Duration timeout;
  LanAddress? _target;

  @override
  Future<bool> permissionGranted() async => true;
  @override
  Future<bool> bluetoothOn() async => true;
  @override
  Future<List<PrinterDevice>> paired() async => const [];

  @override
  Future<bool> connect(String address) async {
    final a = LanAddress.parse(address);
    if (a == null) return false;
    _target = a;
    return realConnector(a.host, a.port, timeout);
  }

  @override
  Future<bool> write(Uint8List bytes) async {
    final a = _target;
    if (a == null) return false;
    try {
      final s = await Socket.connect(a.host, a.port, timeout: timeout);
      s.add(bytes);
      await s.flush();
      await s.close();
      s.destroy();
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> disconnect() async {}
}

/// "192.168.1" of this phone's Wi-Fi / Ethernet address, or null (no private IPv4 address).
Future<String?> localSubnet() async {
  try {
    final ifaces = await NetworkInterface.list(type: InternetAddressType.IPv4, includeLoopback: false);
    for (final i in ifaces) {
      for (final a in i.addresses) {
        final p = a.address.split('.');
        if (p.length == 4 && (p[0] == '192' && p[1] == '168' || p[0] == '10' || p[0] == '172' && (int.tryParse(p[1]) ?? 0) >= 16 && (int.tryParse(p[1]) ?? 0) <= 31)) {
          return p.sublist(0, 3).join('.');
        }
      }
    }
  } catch (_) {/* no network info */}
  return null;
}

/// Looks for hosts of [subnet] ("192.168.1") that accept TCP on [port] (a printer, normally). 254 addresses, [parallel] at a time,
/// [timeout] each: about 6 s on a quiet network. [onFound] fires as printers turn up.
Future<List<String>> scanLan(
  String subnet, {
  int port = 9100,
  Duration timeout = const Duration(milliseconds: 350),
  int parallel = 48,
  LanConnector connector = realConnector,
  void Function(String host)? onFound,
}) async {
  final found = <String>[];
  var next = 1;
  Future<void> worker() async {
    while (true) {
      final n = next++;
      if (n > 254) return;
      final host = '$subnet.$n';
      if (await connector(host, port, timeout)) {
        found.add(host);
        onFound?.call(host);
      }
    }
  }

  await Future.wait([for (var i = 0; i < parallel; i++) worker()]);
  found.sort((a, b) => int.parse(a.split('.').last).compareTo(int.parse(b.split('.').last)));
  return found;
}
