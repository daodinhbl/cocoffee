import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import 'config.dart';

/// The vendor's PUBLIC key (Ed25519, hex). The private half stays with the vendor (scripts/license-tool.js); only codes signed with
/// it are accepted. Replace it together with the private key if that is ever lost or leaked.
const kLicensePublicKeyHex = '31c141ea52b315af09d337bfb19d817f98bff5c9b6d07032188ccd63eb78d9ff';

/// Days of free use from the first start, before a code is needed.
const kTrialDays = 14;

/// The state of the licence of this installation.
enum LicenseState {
  /// a valid code for this machine
  licensed,

  /// no code yet, trial running
  trial,

  /// the code is for another machine (the data folder was copied to a different PC, or the disk changed)
  wrongMachine,

  /// the code's date has passed
  expired,

  /// no code and the trial is over
  trialOver,

  /// the system clock was set back: refuse until the real time is restored
  clockBack,

  /// the code is damaged or not signed by the vendor
  invalid,
}

class LicensePayload {
  const LicensePayload({required this.customer, required this.machine, required this.issued, required this.expires, required this.features});

  factory LicensePayload.fromJson(Map<String, dynamic> j) => LicensePayload(
        customer: '${j['customer'] ?? ''}',
        machine: '${j['machine'] ?? ''}',
        issued: DateTime.tryParse('${j['issued']}') ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        expires: DateTime.tryParse('${j['expires']}') ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        features: [for (final f in (j['features'] as List? ?? const [])) '$f'],
      );

  final String customer, machine;
  final DateTime issued, expires;
  final List<String> features;
}

class LicenseStatus {
  const LicenseStatus(this.state, {this.payload, this.daysLeft = 0, required this.message});
  final LicenseState state;
  final LicensePayload? payload;
  final int daysLeft;
  final String message;

  /// May the services run?
  bool get allowed => state == LicenseState.licensed || state == LicenseState.trial;
}

/// Checks a code. [machineId] is this PC's id; [now] is injectable for tests.
/// The signature covers the exact bytes of the first segment, so any edit (a later date, another machine) breaks it.
Future<({LicenseState state, LicensePayload? payload})> verifyCode(String code, {required String machineId, DateTime? now, String publicKeyHex = kLicensePublicKeyHex}) async {
  final parts = code.trim().split('.');
  if (parts.length != 2 || parts[0].isEmpty || parts[1].isEmpty) return (state: LicenseState.invalid, payload: null);
  LicensePayload payload;
  List<int> sig;
  try {
    payload = LicensePayload.fromJson(Map<String, dynamic>.from(jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[0])))) as Map));
    sig = base64Url.decode(base64Url.normalize(parts[1]));
  } catch (_) {
    return (state: LicenseState.invalid, payload: null);
  }
  final key = SimplePublicKey(_hex(publicKeyHex), type: KeyPairType.ed25519);
  bool ok;
  try {
    ok = await Ed25519().verify(utf8.encode(parts[0]), signature: Signature(sig, publicKey: key));
  } catch (_) {
    ok = false;
  }
  if (!ok) return (state: LicenseState.invalid, payload: null);
  if (payload.machine.toUpperCase() != machineId.toUpperCase()) return (state: LicenseState.wrongMachine, payload: payload);
  if (!(now ?? DateTime.now()).toUtc().isBefore(payload.expires.toUtc())) return (state: LicenseState.expired, payload: payload);
  return (state: LicenseState.licensed, payload: payload);
}

List<int> _hex(String h) => [for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)];

/// Works out the licence status from what is stored in the config and the PC's id. Also keeps the "latest time seen" mark that
/// catches a clock set back to stretch a trial or an expired code (the mark is written by the caller after a successful check).
Future<LicenseStatus> evaluateLicense(AppConfig c, {required String? machineId, DateTime? now}) async {
  final t = (now ?? DateTime.now()).toUtc();
  if (machineId == null) {
    return const LicenseStatus(LicenseState.invalid, message: 'Không đọc được mã máy của Windows (cần chạy chương trình trên Windows với quyền bình thường).');
  }
  final seen = DateTime.tryParse(c.lastSeenAt)?.toUtc();
  if (seen != null && t.isBefore(seen.subtract(const Duration(days: 1)))) {
    return LicenseStatus(LicenseState.clockBack, message: 'Đồng hồ máy tính đang lùi so với lần chạy trước (${seen.toLocal().toString().substring(0, 16)}). Chỉnh lại giờ đúng rồi mở lại chương trình.');
  }
  if (c.licenseCode.isNotEmpty) {
    final r = await verifyCode(c.licenseCode, machineId: machineId, now: t);
    switch (r.state) {
      case LicenseState.licensed:
        final left = r.payload!.expires.toUtc().difference(t).inDays;
        return LicenseStatus(LicenseState.licensed, payload: r.payload, daysLeft: left, message: left <= 14 ? 'Giấy phép còn $left ngày. Liên hệ để gia hạn.' : 'Giấy phép hợp lệ.');
      case LicenseState.wrongMachine:
        return LicenseStatus(LicenseState.wrongMachine, payload: r.payload, message: 'Giấy phép này cấp cho máy khác (${r.payload!.machine}). Gửi mã máy của máy này để được cấp mã mới.');
      case LicenseState.expired:
        return LicenseStatus(LicenseState.expired, payload: r.payload, message: 'Giấy phép đã hết hạn ngày ${r.payload!.expires.toLocal().toString().substring(0, 10)}. Liên hệ để gia hạn.');
      default:
        return const LicenseStatus(LicenseState.invalid, message: 'Mã kích hoạt không hợp lệ.');
    }
  }
  final first = DateTime.tryParse(c.firstRunAt)?.toUtc() ?? t;
  final left = kTrialDays - t.difference(first).inDays;
  if (left > 0) return LicenseStatus(LicenseState.trial, daysLeft: left, message: 'Dùng thử còn $left ngày. Nhập mã kích hoạt để dùng tiếp.');
  return const LicenseStatus(LicenseState.trialOver, message: 'Đã hết thời gian dùng thử. Gửi mã máy cho nhà cung cấp để nhận mã kích hoạt.');
}

/// Checks [code] for this machine and, if it is good, returns the status it gives (the caller stores the code).
Future<LicenseStatus> checkActivationCode(String code, {required String machineId, DateTime? now}) async {
  final r = await verifyCode(code, machineId: machineId, now: now);
  final t = (now ?? DateTime.now()).toUtc();
  return switch (r.state) {
    LicenseState.licensed => LicenseStatus(LicenseState.licensed, payload: r.payload, daysLeft: r.payload!.expires.toUtc().difference(t).inDays, message: 'Đã kích hoạt cho ${r.payload!.customer}.'),
    LicenseState.wrongMachine => LicenseStatus(LicenseState.wrongMachine, payload: r.payload, message: 'Mã này cấp cho máy khác (${r.payload!.machine}), không dùng được ở máy này.'),
    LicenseState.expired => LicenseStatus(LicenseState.expired, payload: r.payload, message: 'Mã này đã hết hạn.'),
    _ => const LicenseStatus(LicenseState.invalid, message: 'Mã kích hoạt không đúng (sai chữ ký hoặc bị sửa).'),
  };
}
