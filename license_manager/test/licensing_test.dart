import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:license_manager/core/licensing.dart';
import 'package:path/path.dart' as p;

const kMachine = 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90';

void main() {
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('licmgr'));
  tearDown(() => tmp.deleteSync(recursive: true));

  test('machine ids are normalised: spaces, case, missing dashes', () {
    expect(normalizeMachineId('a1b2c3d4e5f60718293a4b5c6d7e8f90'), kMachine);
    expect(normalizeMachineId(' a1b2-c3d4-e5f6-0718-293a-4b5c-6d7e-8f90 '), kMachine);
    expect(normalizeMachineId('xyz'), 'XYZ');
  });

  test('validation: machine, customer, days, features', () {
    Payload ok() => buildPayload(machine: kMachine, customer: 'Quán Cò', days: 30, features: ['pos', 'sync'], now: DateTime.utc(2026, 10, 18, 3));
    expect(ok().expires, DateTime.utc(2026, 11, 17, 3));
    for (final f in <void Function()>[
      () => buildPayload(machine: 'sai', customer: 'Quán', days: 30, features: ['pos']),
      () => buildPayload(machine: kMachine, customer: ' ', days: 30, features: ['pos']),
      () => buildPayload(machine: kMachine, customer: 'Quán', days: 0, features: ['pos']),
      () => buildPayload(machine: kMachine, customer: 'Quán', days: 4000, features: ['pos']),
      () => buildPayload(machine: kMachine, customer: 'Quán', days: 30, features: []),
      () => buildPayload(machine: kMachine, customer: 'Quán', days: 30, features: ['hack']),
    ]) {
      expect(f, throwsA(isA<LicenseError>()));
    }
  });

  test('a new key is written as PKCS#8 PEM, never overwritten, and loads back to the same public key', () async {
    final file = p.join(tmp.path, 'license-private.pem');
    final made = await VendorKey.create(file);
    expect(File(file).readAsStringSync(), startsWith('-----BEGIN PRIVATE KEY-----'));
    await expectLater(VendorKey.create(file), throwsA(isA<LicenseError>()));
    final loaded = await VendorKey.load(file);
    expect(loaded.publicHex, made.publicHex);
    expect(made.publicHex.length, 64);
    await expectLater(VendorKey.load(p.join(tmp.path, 'none.pem')), throwsA(isA<LicenseError>()));
    File(p.join(tmp.path, 'bad.pem')).writeAsStringSync('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
    await expectLater(VendorKey.load(p.join(tmp.path, 'bad.pem')), throwsA(isA<LicenseError>()));
  });

  test('Node reads the key Dart made and verifies a Dart code; Dart verifies a Node code from the same key file', () async {
    final file = p.join(tmp.path, 'license-private.pem');
    final key = await VendorKey.create(file);
    final book = LicenseBook(p.join(tmp.path, 'license-db.json'), now: () => DateTime.utc(2026, 10, 18, 3));
    final rec = await book.issue(key, machine: kMachine, customer: 'Quán Cò', days: 90, features: ['pos', 'sync']);
    final root = p.normalize(p.join(Directory.current.path, '..'));
    final script = p.join(root, 'scripts', 'license-core.js');
    if (!File(script).existsSync()) return; // run from another checkout layout
    final node = await Process.run('node', [
      '-e',
      "const c=require(process.argv[1]);const fs=require('fs');"
          "const pub=c.publicHex(require('crypto').createPublicKey(c.loadPrivate(process.argv[2])));"
          "const v=c.verify(process.argv[3],pub);process.stdout.write(JSON.stringify({pub,ok:v.ok,m:v.payload.machine,c:v.payload.customer}));"
          "const code=c.sign(c.buildPayload({machine:process.argv[4],customer:'Khach Node',days:30,features:['pos']}),c.loadPrivate(process.argv[2]));fs.writeFileSync(process.argv[5],code);",
      script, file, rec.code, kMachine, p.join(tmp.path, 'node-code.txt'),
    ]);
    expect(node.exitCode, 0, reason: '${node.stderr}');
    final j = jsonDecode('${node.stdout}') as Map;
    expect(j['pub'], key.publicHex, reason: 'same public key from the same PEM');
    expect(j['ok'], isTrue, reason: 'Node accepts the signature Dart made');
    expect(j['m'], kMachine);
    final fromNode = await decodeCode(File(p.join(tmp.path, 'node-code.txt')).readAsStringSync(), key.publicHex);
    expect(fromNode.signatureValid, isTrue, reason: 'Dart accepts the signature Node made');
    expect(fromNode.payload.customer, 'Khach Node');
  });

  test('decodeCode: a changed code is flagged invalid, garbage is refused', () async {
    final key = await VendorKey.create(p.join(tmp.path, 'k.pem'));
    final code = await key.sign(buildPayload(machine: kMachine, customer: 'Quán', days: 30, features: ['pos']));
    expect((await decodeCode(code, key.publicHex)).signatureValid, isTrue);
    final parts = code.split('.');
    final edited = Map<String, dynamic>.from(jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[0])))) as Map)..['expires'] = '2099-01-01T00:00:00.000Z';
    final forged = '${base64Url.encode(utf8.encode(jsonEncode(edited))).replaceAll('=', '')}.${parts[1]}';
    expect((await decodeCode(forged, key.publicHex)).signatureValid, isFalse);
    final other = await VendorKey.create(p.join(tmp.path, 'k2.pem'));
    expect((await decodeCode(code, other.publicHex)).signatureValid, isFalse);
    for (final junk in ['', 'abc', 'a.b.c', '.x', 'x.']) {
      await expectLater(decodeCode(junk, key.publicHex), throwsA(isA<LicenseError>()), reason: junk);
    }
  });

  test('the ledger: issue, renew (replaces the old code), revoke, CSV, and the same file layout as the web page', () async {
    final key = await VendorKey.create(p.join(tmp.path, 'k.pem'));
    var clock = DateTime.utc(2026, 10, 18, 3);
    final book = LicenseBook(p.join(tmp.path, 'license-db.json'), now: () => clock);
    final a = await book.issue(key, machine: kMachine, customer: 'Quán Cò', days: 30, features: ['pos'], note: 'thử');
    expect(a.isActive, isTrue);
    expect(a.statusLabel(clock).$1, 'Còn hạn (30 ngày)');
    clock = DateTime.utc(2026, 11, 10, 3);
    expect(a.statusLabel(clock).$2, 1, reason: 'under 14 days left');
    final b = await book.renew(key, a.id, 365);
    final all = book.read();
    expect(all.length, 2);
    expect(all.firstWhere((l) => l.id == a.id).status, 'replaced');
    expect(b.payload.expires, DateTime.utc(2027, 11, 10, 3));
    book.revoke(b.id);
    expect(book.read().last.status, 'revoked');
    expect(() => book.revoke(b.id), throwsA(isA<LicenseError>()));
    await expectLater(book.renew(key, b.id, 30), throwsA(isA<LicenseError>()));
    final raw = jsonDecode(File(book.file).readAsStringSync()) as Map;
    expect((raw['licenses'] as List).first, containsPair('machine', kMachine));
    expect((raw['licenses'] as List).first.keys, containsAll(['id', 'customer', 'machine', 'issued', 'expires', 'features', 'note', 'status', 'code']));
    final csv = book.csv();
    expect(csv, startsWith('﻿Khách hàng,Mã máy'));
    expect(csv, contains('"Quán Cò","$kMachine"'));
    expect(csv, contains('Đã thu hồi'));
    expect(File('${book.file}.tmp').existsSync(), isFalse);
  });

  test('a backed-up private key can be imported once and gives the same public key', () async {
    final a = await VendorKey.create(p.join(tmp.path, 'a', 'license-private.pem'));
    final pem = File(a.file).readAsStringSync();
    final b = await VendorKey.importPem(p.join(tmp.path, 'b', 'license-private.pem'), pem);
    expect(b.publicHex, a.publicHex);
    await expectLater(VendorKey.importPem(b.file, pem), throwsA(isA<LicenseError>()));        // never overwrites
    await expectLater(VendorKey.importPem(p.join(tmp.path, 'c', 'license-private.pem'), 'khong phai khoa'), throwsA(isA<LicenseError>()));
    expect(File(p.join(tmp.path, 'c', 'license-private.pem')).existsSync(), isFalse);
  });

  test('ledger merge between devices: union by id, revoke wins, unsigned rows refused', () async {
    final key = await VendorKey.create(p.join(tmp.path, 'k', 'license-private.pem'));
    final win = LicenseBook(p.join(tmp.path, 'win', 'db.json'), now: () => DateTime.utc(2026, 10, 18));
    final phone = LicenseBook(p.join(tmp.path, 'phone', 'db.json'), now: () => DateTime.utc(2026, 10, 18));
    final a = await win.issue(key, machine: kMachine, customer: 'Quán A', days: 30, features: ['pos']);
    final b = await phone.issue(key, machine: kMachine, customer: 'Quán B', days: 30, features: ['pos']);
    var r = await phone.mergeJson(win.exportJson(), key.publicHex);
    expect((r.added, r.updated, r.refused), (1, 0, 0));
    expect(phone.read().map((l) => l.payload.customer), unorderedEquals(['Quán A', 'Quán B']));
    r = await phone.mergeJson(win.exportJson(), key.publicHex);                                     // same again: nothing changes
    expect((r.added, r.updated), (0, 0));
    phone.revoke(a.id);                                                                             // revoked on the phone ...
    r = await win.mergeJson(phone.exportJson(), key.publicHex);                                     // ... reaches Windows
    expect((r.added, r.updated), (1, 1));
    expect(win.read().firstWhere((l) => l.id == a.id).status, 'revoked');
    r = await phone.mergeJson(win.exportJson(), key.publicHex);                                     // and an old "active" copy never un-revokes
    expect(phone.read().firstWhere((l) => l.id == a.id).status, 'revoked');
    expect(r.updated, 0);
    final other = await VendorKey.create(p.join(tmp.path, 'k2', 'license-private.pem'));
    final foreign = LicenseBook(p.join(tmp.path, 'f', 'db.json'));
    await foreign.issue(other, machine: kMachine, customer: 'Lạ', days: 30, features: ['pos']);
    r = await win.mergeJson(foreign.exportJson(), key.publicHex);
    expect((r.added, r.refused), (0, 1));
    await expectLater(win.mergeJson('not json', key.publicHex), throwsA(isA<LicenseError>()));
    expect(b.id, isNotEmpty);
  });
}
