import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as p;

/// Licences of POS Tasotek Server: base64url(payload JSON) + "." + base64url(Ed25519 signature of the first segment).
/// The same format as scripts/license-core.js and the check in the Windows manager (desktop/lib/core/license.dart).
const kFeatures = ['pos', 'sync', 'zalo', 'tax'];
final _machineRe = RegExp(r'^[0-9A-F]{4}(-[0-9A-F]{4}){7}$');

class LicenseError implements Exception {
  LicenseError(this.message);
  final String message;
  @override
  String toString() => message;
}

String _b64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');
List<int> _unb64u(String s) => base64Url.decode(base64Url.normalize(s));
String hexOf(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// "a1b2c3d4 e5f6..." / 32 hex characters / already dashed -> "A1B2-C3D4-...". Anything else is returned upper-cased and trimmed.
String normalizeMachineId(String raw) {
  final t = raw.trim().toUpperCase();
  final hex = t.replaceAll(RegExp(r'[^0-9A-F]'), '');
  if (hex.length == 32 && RegExp(r'^[0-9A-F\s-]+$').hasMatch(t)) {
    return [for (var i = 0; i < 32; i += 4) hex.substring(i, i + 4)].join('-');
  }
  return t;
}

class Payload {
  Payload({required this.customer, required this.machine, required this.issued, required this.expires, required this.features});

  factory Payload.fromJson(Map<String, dynamic> j) => Payload(
        customer: '${j['customer'] ?? ''}',
        machine: '${j['machine'] ?? ''}',
        issued: DateTime.tryParse('${j['issued']}')?.toUtc() ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        expires: DateTime.tryParse('${j['expires']}')?.toUtc() ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        features: [for (final f in (j['features'] as List? ?? const [])) '$f'],
      );

  final String customer, machine;
  final DateTime issued, expires;
  final List<String> features;

  Map<String, dynamic> toJson() => {'v': 1, 'customer': customer, 'machine': machine, 'issued': issued.toIso8601String(), 'expires': expires.toIso8601String(), 'features': features};
}

/// Validates the form inputs (same rules as the web page) and returns the payload to sign.
Payload buildPayload({required String machine, required String customer, required int days, required List<String> features, DateTime? now}) {
  final m = normalizeMachineId(machine);
  if (!_machineRe.hasMatch(m)) throw LicenseError('Mã máy không đúng dạng (8 nhóm 4 ký tự 0-9 A-F, ví dụ A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90).');
  final c = customer.trim();
  if (c.length < 2 || c.length > 80) throw LicenseError('Tên khách hàng cần 2-80 ký tự.');
  if (days < 1 || days > 3660) throw LicenseError('Số ngày phải từ 1 đến 3660.');
  final f = features.toSet().toList();
  if (f.isEmpty || f.any((x) => !kFeatures.contains(x))) throw LicenseError('Chọn ít nhất một tính năng hợp lệ (${kFeatures.join(', ')}).');
  final t = (now ?? DateTime.now()).toUtc();
  return Payload(customer: c, machine: m, issued: t, expires: t.add(Duration(days: days)), features: f);
}

/// The vendor's key pair, kept as a PKCS#8 PEM file (the same file scripts/license-tool.js makes and reads).
class VendorKey {
  VendorKey._(this.pair, this.publicHex, this.file);
  final SimpleKeyPair pair;
  final String publicHex;
  final String file;

  static const _pkcs8Prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

  static Future<VendorKey> _fromSeed(List<int> seed, String file) async {
    final pair = await Ed25519().newKeyPairFromSeed(seed);
    final pub = await pair.extractPublicKey();
    return VendorKey._(pair, hexOf(pub.bytes), file);
  }

  /// Loads the private key; throws LicenseError when the file is missing or is not an Ed25519 PKCS#8 PEM.
  static Future<VendorKey> load(String file) async {
    final f = File(file);
    if (!f.existsSync()) throw LicenseError('Chưa có khóa riêng: $file');
    final body = f.readAsStringSync().replaceAll(RegExp(r'-----[A-Z ]+-----|\s'), '');
    List<int> der;
    try {
      der = base64.decode(body);
    } catch (_) {
      throw LicenseError('File khóa không đọc được (không phải PEM).');
    }
    var prefixOk = der.length == 48;
    for (var i = 0; prefixOk && i < 16; i++) {
      if (der[i] != _pkcs8Prefix[i]) prefixOk = false;
    }
    if (!prefixOk) {
      throw LicenseError('File khóa không phải khóa riêng Ed25519 (PKCS#8).');
    }
    return _fromSeed(der.sublist(16), file);
  }

  /// Writes a private key pasted from a backup (PEM text). Checks it first; refuses to overwrite an existing file.
  static Future<VendorKey> importPem(String file, String pem) async {
    if (File(file).existsSync()) throw LicenseError('Đã có khóa riêng ở $file, không ghi đè.');
    Directory(p.dirname(file)).createSync(recursive: true);
    final tmp = File('$file.import')..writeAsStringSync('${pem.trim()}\n');
    try {
      final k = await load(tmp.path);
      tmp.renameSync(file);
      return VendorKey._(k.pair, k.publicHex, file);
    } finally {
      if (tmp.existsSync()) tmp.deleteSync();
    }
  }

  /// Makes a new key and writes it. Refuses to overwrite an existing file: losing the private key means no new codes.
  static Future<VendorKey> create(String file, {Random? random}) async {
    if (File(file).existsSync()) throw LicenseError('Đã có khóa riêng ở $file, không ghi đè.');
    final r = random ?? Random.secure();
    final seed = List<int>.generate(32, (_) => r.nextInt(256));
    final der = [..._pkcs8Prefix, ...seed];
    final b64 = base64.encode(der);
    final lines = [for (var i = 0; i < b64.length; i += 64) b64.substring(i, min(i + 64, b64.length))];
    Directory(p.dirname(file)).createSync(recursive: true);
    File(file).writeAsStringSync('-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n');
    return _fromSeed(seed, file);
  }

  Future<String> sign(Payload payload) async {
    final seg = _b64u(utf8.encode(jsonEncode(payload.toJson())));
    final sig = await Ed25519().sign(utf8.encode(seg), keyPair: pair);
    return '$seg.${_b64u(sig.bytes)}';
  }
}

class Decoded {
  Decoded(this.payload, this.signatureValid);
  final Payload payload;
  final bool signatureValid;
}

/// Reads a code and checks its signature with [publicHex]. Throws LicenseError when it is not a code at all.
Future<Decoded> decodeCode(String code, String publicHex) async {
  final parts = code.trim().split('.');
  if (parts.length != 2 || parts.any((s) => s.isEmpty)) throw LicenseError('Không phải mã kích hoạt.');
  Payload payload;
  List<int> sig;
  try {
    payload = Payload.fromJson(Map<String, dynamic>.from(jsonDecode(utf8.decode(_unb64u(parts[0]))) as Map));
    sig = _unb64u(parts[1]);
  } catch (_) {
    throw LicenseError('Không đọc được mã kích hoạt.');
  }
  final pub = SimplePublicKey([for (var i = 0; i < publicHex.length; i += 2) int.parse(publicHex.substring(i, i + 2), radix: 16)], type: KeyPairType.ed25519);
  bool ok;
  try {
    ok = await Ed25519().verify(utf8.encode(parts[0]), signature: Signature(sig, publicKey: pub));
  } catch (_) {
    ok = false;
  }
  return Decoded(payload, ok);
}

class IssuedLicense {
  IssuedLicense({required this.id, required this.payload, required this.note, required this.status, required this.code});

  factory IssuedLicense.fromJson(Map<String, dynamic> j) => IssuedLicense(
        id: '${j['id']}',
        payload: Payload.fromJson(j),
        note: '${j['note'] ?? ''}',
        status: '${j['status'] ?? 'active'}',
        code: '${j['code'] ?? ''}',
      );

  final String id;
  final Payload payload;
  final String note;
  String status; // active | replaced | revoked
  final String code;

  Map<String, dynamic> toJson() => {
        'id': id, 'customer': payload.customer, 'machine': payload.machine, 'issued': payload.issued.toIso8601String(), 'expires': payload.expires.toIso8601String(),
        'features': payload.features, 'note': note, 'status': status, 'code': code,
      };

  bool get isActive => status == 'active';

  /// ("Còn hạn (27 ngày)" etc.) as the label and a severity: 0 fine, 1 soon, 2 bad.
  (String, int) statusLabel(DateTime now) {
    if (status == 'revoked') return ('Đã thu hồi', 2);
    if (status == 'replaced') return ('Đã được thay bằng mã mới', 0);
    final left = payload.expires.difference(now.toUtc()).inHours / 24;
    final days = left.ceil();
    if (left < 0) return ('Hết hạn', 2);
    if (days <= 14) return ('Sắp hết hạn (còn $days ngày)', 1);
    return ('Còn hạn ($days ngày)', 0);
  }
}

/// The ledger of issued codes: license-db.json next to the key (the same file and layout the local web page uses).
class LicenseBook {
  LicenseBook(this.file, {DateTime Function()? now}) : now = now ?? DateTime.now;
  final String file;
  final DateTime Function() now;

  List<IssuedLicense> read() {
    try {
      final j = jsonDecode(File(file).readAsStringSync()) as Map;
      return [for (final l in (j['licenses'] as List? ?? const [])) IssuedLicense.fromJson(Map<String, dynamic>.from(l as Map))];
    } catch (_) {
      return [];
    }
  }

  void _write(List<IssuedLicense> all) {
    Directory(p.dirname(file)).createSync(recursive: true);
    final tmp = File('$file.tmp');
    tmp.writeAsStringSync(const JsonEncoder.withIndent('  ').convert({'licenses': [for (final l in all) l.toJson()]}), flush: true);
    tmp.renameSync(file);
  }

  static String _id() => hexOf(List<int>.generate(6, (_) => Random.secure().nextInt(256)));

  Future<IssuedLicense> issue(VendorKey key, {required String machine, required String customer, required int days, required List<String> features, String note = '', String? replaces}) async {
    final payload = buildPayload(machine: machine, customer: customer, days: days, features: features, now: now());
    final rec = IssuedLicense(id: _id(), payload: payload, note: note.length > 120 ? note.substring(0, 120) : note, status: 'active', code: await key.sign(payload));
    final all = read();
    if (replaces != null) {
      for (final l in all) {
        if (l.id == replaces) l.status = 'replaced';
      }
    }
    all.add(rec);
    _write(all);
    return rec;
  }

  Future<IssuedLicense> renew(VendorKey key, String id, int days) async {
    final old = read().where((l) => l.id == id && l.isActive).firstOrNull;
    if (old == null) throw LicenseError('Không tìm thấy mã còn hiệu lực để gia hạn.');
    return issue(key, machine: old.payload.machine, customer: old.payload.customer, days: days, features: old.payload.features, note: old.note, replaces: id);
  }

  void revoke(String id) {
    final all = read();
    final l = all.where((x) => x.id == id && x.isActive).firstOrNull;
    if (l == null) throw LicenseError('Không tìm thấy mã còn hiệu lực để thu hồi.');
    l.status = 'revoked';
    _write(all);
  }

  /// The ledger as JSON text, the same layout as license-db.json (what "Sao chép sổ" puts on the clipboard).
  String exportJson() => const JsonEncoder.withIndent('  ').convert({'licenses': [for (final l in read()) l.toJson()]});

  static int _rank(String s) => switch (s) { 'revoked' => 3, 'replaced' => 2, _ => 1 };

  /// Merges a ledger from another device (Windows <-> iPhone) into this one. Rows are matched by id; a row only moves "forward"
  /// (active -> replaced -> revoked), so a revoke made on either device wins. Rows whose code was not signed by [publicHex] are
  /// refused (junk or somebody else's ledger). Returns how many rows were added / updated / refused.
  Future<({int added, int updated, int refused})> mergeJson(String text, String publicHex) async {
    Object? j;
    try {
      j = jsonDecode(text);
    } catch (_) {
      throw LicenseError('Nội dung dán vào không phải sổ cấp phép (JSON).');
    }
    final rows = j is Map ? j['licenses'] : null;
    if (rows is! List) throw LicenseError('Nội dung dán vào không phải sổ cấp phép.');
    final all = read();
    final byId = {for (final l in all) l.id: l};
    var added = 0, updated = 0, refused = 0;
    for (final raw in rows) {
      IssuedLicense rec;
      try {
        rec = IssuedLicense.fromJson(Map<String, dynamic>.from(raw as Map));
        final d = await decodeCode(rec.code, publicHex);
        if (!d.signatureValid || d.payload.machine != rec.payload.machine) throw LicenseError('bad');
      } catch (_) {
        refused++;
        continue;
      }
      final mine = byId[rec.id];
      if (mine == null) {
        all.add(rec);
        byId[rec.id] = rec;
        added++;
      } else if (_rank(rec.status) > _rank(mine.status)) {
        mine.status = rec.status;
        updated++;
      }
    }
    if (added + updated > 0) {
      all.sort((a, b) => a.payload.issued.compareTo(b.payload.issued));
      _write(all);
    }
    return (added: added, updated: updated, refused: refused);
  }

  /// A spreadsheet-friendly list (UTF-8 with BOM so Excel shows Vietnamese correctly).
  String csv() {
    String q(String s) => '"${s.replaceAll('"', '""')}"';
    final rows = <String>['Khách hàng,Mã máy,Ngày cấp,Hết hạn,Tính năng,Trạng thái,Ghi chú'];
    for (final l in read()) {
      rows.add([q(l.payload.customer), q(l.payload.machine), l.payload.issued.toIso8601String().substring(0, 10), l.payload.expires.toIso8601String().substring(0, 10), q(l.payload.features.join(' ')), q(l.statusLabel(now()).$1), q(l.note)].join(','));
    }
    return '﻿${rows.join('\r\n')}\r\n';
  }
}
