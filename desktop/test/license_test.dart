import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pos_tasotek_server/core/config.dart';
import 'package:pos_tasotek_server/core/license.dart';
import 'package:pos_tasotek_server/core/machine_id.dart';
import 'package:pos_tasotek_server/core/stack.dart';
import 'package:pos_tasotek_server/core/supervisor.dart';

import 'core_test.dart' show FakeLauncher;

/// Issued by scripts/license-tool.js with the real vendor key, for the made-up machine below (valid until 2036).
const kNodeToken =
    'eyJ2IjoxLCJjdXN0b21lciI6IktoYWNoIHRodSBuZ2hpZW0iLCJtYWNoaW5lIjoiQUFBQS1CQkJCLUNDQ0MtRERERC1FRUVFLUZGRkYtMDAwMC0xMTExIiwiaXNzdWVkIjoiMjAyNi0xMC0xOFQwNjowMjowNi4zMTdaIiwiZXhwaXJlcyI6IjIwMzYtMTAtMTVUMDY6MDI6MDYuMzE3WiIsImZlYXR1cmVzIjpbInBvcyIsInN5bmMiXX0.8Rr-LwHl6-t-NRAP-JxwN6DvsaJSx8gjxZCy7JtcID7CioAAYIilvvyjEHSU1CGTp_89mIS1kJSGgvjQIXDeAw';
const kFakeMachine = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111';
const kOtherMachine = 'FFFF-FFFF-FFFF-FFFF-FFFF-FFFF-FFFF-FFFF';

/// A test vendor: signs payloads with its own key so expiry / tampering can be tried.
class TestVendor {
  late final SimpleKeyPair pair;
  late final String publicHex;

  Future<TestVendor> init() async {
    pair = await Ed25519().newKeyPair();
    final pub = await pair.extractPublicKey();
    publicHex = pub.bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return this;
  }

  Future<String> issue({String machine = kFakeMachine, DateTime? expires}) async {
    final payload = {
      'v': 1,
      'customer': 'Quán A',
      'machine': machine,
      'issued': DateTime.utc(2026, 1, 1).toIso8601String(),
      'expires': (expires ?? DateTime.utc(2027, 1, 1)).toIso8601String(),
      'features': ['pos'],
    };
    final seg = base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
    final sig = await Ed25519().sign(utf8.encode(seg), keyPair: pair);
    return '$seg.${base64Url.encode(sig.bytes).replaceAll('=', '')}';
  }
}

void main() {
  group('machine id', () {
    test('the same machine always gives the same id; any change of guid or disk gives another', () {
      final a = machineIdFrom(guid: '6F1C2D3E-1111-2222-3333-444455556666', volumeSerial: '1A2B-3C4D');
      expect(a, matches(RegExp(r'^([0-9A-F]{4}-){7}[0-9A-F]{4}$')));
      expect(machineIdFrom(guid: '6f1c2d3e-1111-2222-3333-444455556666 ', volumeSerial: '1a2b-3c4d'), a, reason: 'case and spaces do not matter');
      expect(machineIdFrom(guid: '6F1C2D3E-1111-2222-3333-444455556667', volumeSerial: '1A2B-3C4D'), isNot(a));
      expect(machineIdFrom(guid: '6F1C2D3E-1111-2222-3333-444455556666', volumeSerial: '1A2B-3C4E'), isNot(a));
    });

    test('parsing the Windows tools output, in any language', () {
      expect(parseMachineGuid('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1c2d3e-1111-2222-3333-444455556666\r\n'), '6f1c2d3e-1111-2222-3333-444455556666');
      expect(parseMachineGuid('khong co'), isNull);
      expect(parseVolumeSerial(' Volume in drive C has no label.\r\n Volume Serial Number is 1A2B-3C4D\r\n'), '1A2B-3C4D');
      expect(parseVolumeSerial(' Ổ đĩa C không có nhãn.\r\n Số sê-ri của ổ đĩa là 9F8E-7D6C\r\n'), '9F8E-7D6C');
      expect(parseVolumeSerial('nothing'), isNull);
    });

    test('this very PC gives an id (Windows only)', () async {
      final id = await readMachineId();
      if (Platform.isWindows) {
        expect(id, isNotNull);
        expect(id, matches(RegExp(r'^([0-9A-F]{4}-){7}[0-9A-F]{4}$')));
        expect(await readMachineId(), id, reason: 'stable between calls');
      }
    });
  });

  group('verifyCode', () {
    test('a code issued by Node with the real vendor key verifies in Dart (same bytes, same signature)', () async {
      final r = await verifyCode(kNodeToken, machineId: kFakeMachine, now: DateTime.utc(2026, 10, 18));
      expect(r.state, LicenseState.licensed);
      expect(r.payload!.customer, 'Khach thu nghiem');
      expect(r.payload!.features, ['pos', 'sync']);
    });

    test('wrong machine, expired, edited and garbage codes are refused', () async {
      final v = await TestVendor().init();
      final code = await v.issue(expires: DateTime.utc(2026, 12, 31));
      final now = DateTime.utc(2026, 6, 1);
      expect((await verifyCode(code, machineId: kFakeMachine, now: now, publicKeyHex: v.publicHex)).state, LicenseState.licensed);
      expect((await verifyCode(code, machineId: kOtherMachine, now: now, publicKeyHex: v.publicHex)).state, LicenseState.wrongMachine);
      expect((await verifyCode(code, machineId: kFakeMachine, now: DateTime.utc(2027, 1, 1), publicKeyHex: v.publicHex)).state, LicenseState.expired);
      // edit the payload (a later date): the signature no longer matches
      final parts = code.split('.');
      final edited = Map<String, dynamic>.from(jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[0])))) as Map)..['expires'] = '2099-01-01T00:00:00.000Z';
      final forged = '${base64Url.encode(utf8.encode(jsonEncode(edited))).replaceAll('=', '')}.${parts[1]}';
      expect((await verifyCode(forged, machineId: kFakeMachine, now: now, publicKeyHex: v.publicHex)).state, LicenseState.invalid);
      // a code of another vendor is not accepted by the real public key
      expect((await verifyCode(code, machineId: kFakeMachine, now: now)).state, LicenseState.invalid);
      for (final junk in ['', 'abc', 'a.b', '....', 'x.y.z']) {
        expect((await verifyCode(junk, machineId: kFakeMachine)).state, LicenseState.invalid, reason: junk);
      }
    });
  });

  group('evaluateLicense', () {
    AppConfig cfg({String first = '', String seen = '', String code = ''}) => AppConfig.fresh()
      ..firstRunAt = first
      ..lastSeenAt = seen
      ..licenseCode = code;

    test('no code: a 14-day trial from the first start, then locked', () async {
      final first = DateTime.utc(2026, 10, 1).toIso8601String();
      var s = await evaluateLicense(cfg(first: first), machineId: kFakeMachine, now: DateTime.utc(2026, 10, 5));
      expect(s.state, LicenseState.trial);
      expect(s.daysLeft, 10);
      expect(s.allowed, isTrue);
      s = await evaluateLicense(cfg(first: first), machineId: kFakeMachine, now: DateTime.utc(2026, 10, 15, 1));
      expect(s.state, LicenseState.trialOver);
      expect(s.allowed, isFalse);
    });

    test('a valid code for this machine: licensed, with the days left and a reminder in the last 14', () async {
      var s = await evaluateLicense(cfg(code: kNodeToken), machineId: kFakeMachine, now: DateTime.utc(2026, 10, 18));
      expect(s.state, LicenseState.licensed);
      expect(s.allowed, isTrue);
      expect(s.daysLeft, greaterThan(3000));
      expect(s.message, 'Giấy phép hợp lệ.');
      s = await evaluateLicense(cfg(code: kNodeToken), machineId: kFakeMachine, now: DateTime.utc(2036, 10, 10));
      expect(s.message, contains('còn'));
    });

    test('the same code on another PC (data folder copied) is refused, naming the machine it was issued for', () async {
      final s = await evaluateLicense(cfg(code: kNodeToken), machineId: kOtherMachine, now: DateTime.utc(2026, 10, 18));
      expect(s.state, LicenseState.wrongMachine);
      expect(s.allowed, isFalse);
      expect(s.message, contains(kFakeMachine));
    });

    test('expired code: locked', () async {
      final s = await evaluateLicense(cfg(code: kNodeToken), machineId: kFakeMachine, now: DateTime.utc(2036, 10, 16));
      expect(s.state, LicenseState.expired);
      expect(s.allowed, isFalse);
    });

    test('a clock set back more than a day is caught, small drifts are not', () async {
      final first = DateTime.utc(2026, 10, 12).toIso8601String();
      final seen = DateTime.utc(2026, 10, 18, 12).toIso8601String();
      expect((await evaluateLicense(cfg(first: first, seen: seen), machineId: kFakeMachine, now: DateTime.utc(2026, 10, 18, 11))).allowed, isTrue);
      final back = await evaluateLicense(cfg(first: first, seen: seen), machineId: kFakeMachine, now: DateTime.utc(2026, 10, 10));
      expect(back.state, LicenseState.clockBack);
      expect(back.allowed, isFalse);
    });

    test('no machine id: not allowed, with the reason', () async {
      final s = await evaluateLicense(cfg(), machineId: null);
      expect(s.allowed, isFalse);
      expect(s.message, contains('mã máy'));
    });

    test('checkActivationCode explains each refusal', () async {
      expect((await checkActivationCode(kNodeToken, machineId: kFakeMachine, now: DateTime.utc(2026, 10, 18))).message, contains('Khach thu nghiem'));
      expect((await checkActivationCode(kNodeToken, machineId: kOtherMachine)).message, contains('máy khác'));
      expect((await checkActivationCode('rác', machineId: kFakeMachine)).message, contains('không đúng'));
    });
  });

  group('the stack obeys the licence', () {
    late Directory tmp;
    late InstallPaths paths;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('lic');
      paths = InstallPaths(installDir: p.join(tmp.path, 'i'), dataDir: p.join(tmp.path, 'd'));
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    StackController make(FakeLauncher l, Future<LicenseStatus> Function() check) {
      final store = ConfigStore(paths);
      return StackController(
        paths: paths,
        store: store,
        config: store.loadOrCreate(),
        launcher: l,
        pollEvery: const Duration(milliseconds: 5),
        tcp: (h, port) async => true,
        health: (port) async => true,
        licenseCheck: check,
      );
    }

    test('refused: nothing is started', () async {
      final l = FakeLauncher();
      final s = make(l, () async => const LicenseStatus(LicenseState.wrongMachine, message: 'Sai máy'));
      await s.startAll();
      expect(l.started, isEmpty);
      expect(l.ran, isEmpty);
      expect(s.license!.state, LicenseState.wrongMachine);
    });

    test('allowed: starts as usual', () async {
      final l = FakeLauncher();
      final s = make(l, () async => const LicenseStatus(LicenseState.trial, daysLeft: 9, message: 'Dùng thử'));
      await s.startAll();
      expect(s.web.current, ServiceState.running);
    });

    test('the licence runs out while the PC stays on: the next check stops every service', () async {
      final l = FakeLauncher();
      var allowed = true;
      final s = make(l, () async => allowed ? const LicenseStatus(LicenseState.licensed, message: 'ok') : const LicenseStatus(LicenseState.expired, message: 'Hết hạn'));
      await s.startAll();
      expect(s.web.current, ServiceState.running);
      allowed = false;
      expect(await s.recheckLicense(), isFalse);
      expect(s.web.current, ServiceState.stopped);
      expect(s.db.current, ServiceState.stopped);
    });
  });
}
