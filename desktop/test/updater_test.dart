import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pos_tasotek_server/core/ngrok.dart';
import 'package:pos_tasotek_server/core/updater.dart';

Map<String, dynamic> manifest({String version = '1.1.0', String? file, int size = 100, String? sha}) => {
      'version_name': version,
      'file': file ?? 'POS-Tasotek-Server-Setup-$version.exe',
      'size': size,
      'sha256': sha ?? 'a' * 64,
    };

void main() {
  test('versions compare numerically', () {
    expect(versionIsNewer('1.10.0', '1.9.9'), isTrue);
    expect(versionIsNewer('1.0.0', '1.0.0'), isFalse);
    expect(versionIsNewer('1.0', '1.0.1'), isFalse);
    expect(versionIsNewer('2.0.0', '1.99.99'), isTrue);
  });

  test('a manifest is accepted only with a safe file name and a real hash', () {
    expect(WindowsRelease.tryParse(manifest()), isNotNull);
    expect(WindowsRelease.tryParse(manifest(file: '../evil.exe')), isNull);
    expect(WindowsRelease.tryParse(manifest(file: 'POS-Tasotek-Server-Setup-1.1.0.exe/../../x')), isNull);
    expect(WindowsRelease.tryParse(manifest(sha: 'xyz')), isNull);
    expect(WindowsRelease.tryParse(manifest(size: 0)), isNull);
    expect(WindowsRelease.tryParse('nope'), isNull);
  });

  test('check: newer, same, no release, failures', () async {
    WindowsUpdater answering(HttpAnswer a) => WindowsUpdater(
          server: 'https://shop.example/',
          http: (m, u, {headers, body}) async {
            expect(u.toString(), 'https://shop.example/download/windows/manifest.json');
            return a;
          },
        );
    expect((await answering(HttpAnswer(200, jsonEncode(manifest()))).check('1.0.0'))!.version, '1.1.0');
    expect(await answering(HttpAnswer(200, jsonEncode(manifest()))).check('1.1.0'), isNull);
    expect(await answering(const HttpAnswer(404, '{}')).check('1.0.0'), isNull);
    await expectLater(answering(const HttpAnswer(500, '')).check('1.0.0'), throwsA(isA<UpdateException>()));
    await expectLater(answering(const HttpAnswer(200, '<html>')).check('1.0.0'), throwsA(isA<UpdateException>()));
    await expectLater(WindowsUpdater(server: 'http://evil.example').check('1.0.0'), throwsA(isA<UpdateException>()), reason: 'plain http to a remote host is refused');
  });

  test('download verifies size and SHA-256 and deletes a bad file', () async {
    final bytes = List<int>.generate(5000, (i) => i % 251);
    final server = await HttpServer.bind('127.0.0.1', 0);
    server.listen((req) async {
      req.response.add(bytes);
      await req.response.close();
    });
    final dir = Directory.systemTemp.createTempSync('upd');
    addTearDown(() async {
      await server.close(force: true);
      dir.deleteSync(recursive: true);
    });
    final u = WindowsUpdater(server: 'http://127.0.0.1:${server.port}', tempDir: dir.path);
    final good = WindowsRelease(version: '1.1.0', file: 'POS-Tasotek-Server-Setup-1.1.0.exe', size: bytes.length, sha256: sha256.convert(bytes).toString());
    final progress = <double>[];
    final path = await u.download(good, onProgress: progress.add);
    expect(File(path).lengthSync(), bytes.length);
    expect(p.basename(path), good.file);
    expect(progress.last, 1.0);
    final bad = WindowsRelease(version: '1.1.0', file: good.file, size: bytes.length, sha256: 'b' * 64);
    await expectLater(u.download(bad), throwsA(isA<UpdateException>()));
    expect(File(path).existsSync(), isFalse, reason: 'a file that fails the check is removed');
    final tooBig = WindowsRelease(version: '1.1.0', file: good.file, size: 10, sha256: good.sha256);
    await expectLater(u.download(tooBig), throwsA(isA<UpdateException>()));
  });
}
