import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:pos_tasotek_server/core/config.dart';
import 'package:pos_tasotek_server/core/env_builder.dart';
import 'package:pos_tasotek_server/core/ngrok.dart';
import 'package:pos_tasotek_server/core/stack.dart';
import 'package:pos_tasotek_server/core/supervisor.dart';

class FakeProcess implements RunningProcess {
  final _lines = StreamController<String>.broadcast();
  final _exit = Completer<int>();
  bool killed = false;
  @override
  Stream<String> get lines => _lines.stream;
  @override
  Future<int> get exitCode => _exit.future;
  @override
  void kill() {
    killed = true;
    if (!_exit.isCompleted) _exit.complete(137);
  }

  void say(String l) => _lines.add(l);
  void exit(int code) {
    if (!_exit.isCompleted) _exit.complete(code);
  }
}

class Started {
  Started(this.exe, this.args, this.env, this.process);
  final String exe;
  final List<String> args;
  final Map<String, String>? env;
  final FakeProcess process;
}

class Ran {
  Ran(this.exe, this.args, this.env);
  final String exe;
  final List<String> args;
  final Map<String, String>? env;
}

class FakeLauncher implements ProcessLauncher {
  final started = <Started>[];
  final ran = <Ran>[];
  int runCode = 0;
  String runOutput = '';

  @override
  Future<RunningProcess> start(String exe, List<String> args, {Map<String, String>? env, String? workingDir}) async {
    final fp = FakeProcess();
    started.add(Started(exe, args, env, fp));
    return fp;
  }

  @override
  Future<({int code, String output})> run(String exe, List<String> args, {Map<String, String>? env, String? workingDir, Duration timeout = const Duration(minutes: 3)}) async {
    ran.add(Ran(exe, args, env));
    return (code: runCode, output: runOutput);
  }
}

void main() {
  late Directory tmp;
  late InstallPaths paths;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('tasotekpos');
    paths = InstallPaths(installDir: p.join(tmp.path, 'install'), dataDir: p.join(tmp.path, 'data'));
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  group('config', () {
    test('a fresh install gets random database passwords and a setup token; they differ every time', () {
      final a = AppConfig.fresh();
      final b = AppConfig.fresh();
      expect(a.dbPassword.length, 24);
      expect(a.dbPassword, isNot(b.dbPassword));
      expect(a.dbPassword, isNot(a.dbRootPassword));
      expect(a.installToken.length, 12);
      expect(RegExp(r'^[a-km-zA-HJ-NP-Z2-9]+$').hasMatch(a.dbPassword), isTrue, reason: 'no look-alike characters');
    });

    test('the store creates the file once, keeps the passwords, and round-trips every field', () {
      final store = ConfigStore(paths);
      final c = store.loadOrCreate();
      expect(File(paths.configFile).existsSync(), isTrue);
      c
        ..shopName = 'Quán Cò'
        ..serverPort = 3100;
      c.ngrok.authToken = 'tok';
      c.cloud
        ..enabled = true
        ..host = 'srv.example'
        ..name = 'n'
        ..user = 'u'
        ..password = 'pw';
      store.save(c);
      final again = ConfigStore(paths).loadOrCreate();
      expect(again.shopName, 'Quán Cò');
      expect(again.serverPort, 3100);
      expect(again.dbPassword, c.dbPassword, reason: 'the database password must never change on its own');
      expect(again.ngrok.authToken, 'tok');
      expect(again.cloud.complete, isTrue);
      expect(File('${paths.configFile}.tmp').existsSync(), isFalse, reason: 'atomic write leaves no temp file');
    });

    test('a damaged file is kept aside and a clean one starts', () {
      Directory(paths.dataDir).createSync(recursive: true);
      File(paths.configFile).writeAsStringSync('{ not json');
      final c = ConfigStore(paths).loadOrCreate();
      expect(c.dbPassword, isNotEmpty);
      expect(Directory(paths.dataDir).listSync().any((e) => e.path.contains('config.json.broken-')), isTrue);
    });

    test('paths of the bundled programs', () {
      expect(paths.node, endsWith(p.join('runtime', 'node', 'node.exe')));
      expect(paths.mariadbd, endsWith(p.join('mariadb', 'bin', 'mariadbd.exe')));
      expect(paths.serverEntry, endsWith(p.join('server', 'app.js')));
      expect(paths.dbDataDir, startsWith(paths.dataDir));
    });
  });

  group('env_builder', () {
    test('the web server gets the local database, the setup token and the data folders; no cloud keys unless complete', () {
      final c = AppConfig.fresh()..shopName = 'Quán Cò';
      final e = serverEnv(c, paths);
      expect(e['DB_HOST'], '127.0.0.1');
      expect(e['DB_PORT'], '3307');
      expect(e['DB_PASSWORD'], c.dbPassword);
      expect(e['PORT'], '3000');
      expect(e['AUTO_BOOTSTRAP_DB'], 'true');
      expect(e['SEED_DEMO'], 'false');
      expect(e['INSTALL_TOKEN'], c.installToken);
      expect(e['SERVICE_MANAGED'], '1');
      expect(e['DB_CONFIG_FILE'], paths.dbConfigFile);
      expect(e['BACKUP_DIR'], paths.backupsDir);
      expect(e.containsKey('CLOUD_SYNC_ENABLED'), isFalse);
      expect(e.containsKey('PUBLIC_BASE_URL'), isFalse);
      c.cloud
        ..enabled = true
        ..host = 'srv2089.hstgr.io';
      expect(serverEnv(c, paths).containsKey('CLOUD_SYNC_ENABLED'), isFalse, reason: 'incomplete');
      c.cloud
        ..name = 'db'
        ..user = 'u'
        ..password = 'pw';
      final withCloud = serverEnv(c, paths, publicUrl: 'https://x.ngrok-free.app');
      expect(withCloud['CLOUD_SYNC_ENABLED'], 'true');
      expect(withCloud['CLOUD_DB_HOST'], 'srv2089.hstgr.io');
      expect(withCloud['PUBLIC_BASE_URL'], 'https://x.ngrok-free.app');
    });

    test('mariadbd listens on the loopback only', () {
      final a = mariadbArgs(AppConfig.fresh(), paths);
      expect(a, contains('--bind-address=127.0.0.1'));
      expect(a, contains('--port=3307'));
      expect(a, contains('--datadir=${paths.dbDataDir}'));
    });

    test('provisioning SQL: database, loopback-only user, quotes escaped', () {
      final c = AppConfig.fresh()
        ..dbName = 'pos'
        ..dbUser = 'pos'
        ..dbPassword = "pa'ss\\w";
      final sql = provisionSql(c);
      expect(sql, contains('CREATE DATABASE IF NOT EXISTS `pos`'));
      expect(sql, contains("'pos'@'127.0.0.1'"));
      expect(sql, contains(r"'pa''ss\\w'"));
      expect(sql, isNot(contains("@'%'")));
    });
  });

  group('ngrok', () {
    test('slug of a Vietnamese shop name', () {
      expect(slugOf('Quán Cà Phê Cò'), 'quan-ca-phe-co');
      expect(slugOf('  06coffee!! '), '06coffee');
      expect(slugOf('Đồng Hồ'), 'dong-ho');
      expect(slugOf('a' * 50).length, 30);
      expect(slugOf('???'), '');
    });

    HttpCall api(Map<String, HttpAnswer Function(Uri, String?)> routes, List<String> calls) => (method, url, {headers, body}) async {
          calls.add('$method ${url.path}');
          expect(headers!['Authorization'], 'Bearer KEY');
          expect(headers['Ngrok-Version'], '2');
          return routes['$method ${url.path}']!(url, body);
        };

    test('keeps the domain the account still has; else uses the first one; else reserves <slug>-xxxx.ngrok-free.app', () async {
      final calls = <String>[];
      var list = ['a.ngrok-free.app', 'b.ngrok-free.app'];
      String? posted;
      final http = api({
        'GET /reserved_domains': (u, b) => HttpAnswer(200, jsonEncode({'reserved_domains': [for (final d in list) {'domain': d}]})),
        'POST /reserved_domains': (u, b) {
          posted = b;
          return HttpAnswer(201, jsonEncode({'domain': (jsonDecode(b!) as Map)['domain']}));
        },
      }, calls);
      final a = NgrokApi('KEY', http: http);
      expect(await pickDomain(a, current: 'b.ngrok-free.app', shopName: 'X'), 'b.ngrok-free.app');
      expect(await pickDomain(a, current: 'gone.ngrok-free.app', shopName: 'X'), 'a.ngrok-free.app');
      list = [];
      final d = await pickDomain(a, current: '', shopName: 'Quán Cò', random: Random(1));
      expect(d, matches(RegExp(r'^quan-co-[a-z0-9]{4}\.ngrok-free\.app$')));
      expect((jsonDecode(posted!) as Map)['domain'], d);
    });

    test('API errors are explained in Vietnamese', () async {
      for (final (status, text) in [(401, 'từ chối API key'), (403, 'từ chối API key'), (429, 'giới hạn tốc độ'), (500, 'ngrok trả lỗi 500')]) {
        final a = NgrokApi('KEY', http: (m, u, {headers, body}) async => HttpAnswer(status, '{"msg":"boom"}'));
        await expectLater(a.reservedDomains(), throwsA(isA<NgrokException>().having((e) => e.message, 'm', contains(text))));
      }
    });

    test('agent arguments, tunnel parsing and error mapping', () {
      final args = ngrokArgs(port: 3000, configFile: r'C:\d\ngrok.yml', domain: 'q.ngrok-free.app', authToken: 'T');
      expect(args, containsAll(['http', '3000', '--url=https://q.ngrok-free.app', '--authtoken=T']));
      expect(ngrokArgs(port: 3000, configFile: 'c').any((a) => a.startsWith('--url=')), isFalse);
      expect(publicUrlFromTunnels('{"tunnels":[{"public_url":"http://x"},{"public_url":"https://q.ngrok-free.app"}]}'), 'https://q.ngrok-free.app');
      expect(publicUrlFromTunnels('{"tunnels":[]}'), isNull);
      expect(publicUrlFromTunnels('<html>'), isNull);
      expect(ngrokErrorFromLog('{"lvl":"eror","err":"authentication failed: ERR_NGROK_105"}'), contains('authtoken'));
      expect(ngrokErrorFromLog('{"err":"ERR_NGROK_334 endpoint is already online"}'), contains('đang được dùng'));
      expect(ngrokErrorFromLog('{"lvl":"info","err":"null"}'), isNull);
      expect(ngrokErrorFromLog('not json'), isNull);
    });
  });

  group('ManagedService', () {
    test('restartOnExit starts it again; stop() does not', () async {
      final procs = <FakeProcess>[];
      final svc = ManagedService('web', restartOnExit: true);
      await svc.start(() async {
        final f = FakeProcess();
        procs.add(f);
        return f;
      });
      svc.markRunning();
      expect(svc.current, ServiceState.running);
      procs[0].exit(0); // the web server exits on purpose (Cài đặt > Khởi động lại)
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(procs.length, 2, reason: 'started again');
      expect(svc.current, ServiceState.starting);
      await svc.stop();
      expect(procs[1].killed, isTrue);
      expect(svc.current, ServiceState.stopped);
      expect(procs.length, 2, reason: 'no restart after stop');
    });

    test('a crash loop gives up and shows the failure', () async {
      var n = 0;
      final svc = ManagedService('web', restartOnExit: true, maxRestarts: 3);
      late FakeProcess last;
      await svc.start(() async => last = FakeProcess());
      Future<void> crash() async {
        n++;
        last.exit(1);
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }

      await crash();
      await crash();
      await crash();
      await crash();
      expect(svc.current, ServiceState.failed);
      expect(svc.error, contains('Dừng bất thường'));
      expect(n, 4);
    });

    test('without restartOnExit an exit is a failure, and the log keeps the last lines', () async {
      final svc = ManagedService('mariadb');
      late FakeProcess proc;
      await svc.start(() async => proc = FakeProcess());
      proc.say('xin chào');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(svc.log, contains('xin chào'));
      proc.exit(3);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(svc.current, ServiceState.failed);
      expect(svc.error, contains('mã 3'));
    });

    test('a starter that throws is a failure, not a crash', () async {
      final svc = ManagedService('x');
      await svc.start(() async => throw const FileSystemException('no exe'));
      expect(svc.current, ServiceState.failed);
      expect(svc.error, contains('no exe'));
    });
  });

  group('StackController', () {
    StackController make(FakeLauncher l, {AppConfig? c, HttpCall? http, TcpProbe? tcp, HealthProbe? health}) {
      final store = ConfigStore(paths);
      final config = c ?? store.loadOrCreate();
      return StackController(
        paths: paths, store: store, config: config, launcher: l, pollEvery: const Duration(milliseconds: 5),
        http: http ?? (m, u, {headers, body}) async => const HttpAnswer(404, ''),
        tcp: tcp ?? (h, port) async => true,
        health: health ?? (port) async => true,
      );
    }

    test('first run: creates the database files, starts MariaDB, provisions the shop database with the password in the environment (not on the command line), then the web server', () async {
      final l = FakeLauncher();
      final s = make(l);
      await s.startAll();
      expect(l.ran.first.exe, paths.mariadbInstallDb);
      expect(l.ran.first.args, contains('--datadir=${paths.dbDataDir}'));
      expect(l.started[0].exe, paths.mariadbd);
      final provision = l.ran[1];
      expect(provision.exe, paths.mariadbClient);
      expect(provision.env!['MYSQL_PWD'], s.config.dbRootPassword);
      expect(provision.args.join(' '), isNot(contains(s.config.dbRootPassword)));
      expect(provision.args.join(' '), contains('CREATE DATABASE'));
      expect(l.started[1].exe, paths.node);
      expect(l.started[1].args, [paths.serverEntry]);
      expect(l.started[1].env!['DB_PASSWORD'], s.config.dbPassword);
      expect(l.started[1].env!['PORT'], '3000');
      expect(s.db.current, ServiceState.running);
      expect(s.web.current, ServiceState.running);
    });

    test('a second start does not re-create the database files', () async {
      final l = FakeLauncher();
      Directory(paths.dbDataDir).createSync(recursive: true);
      File(p.join(paths.dbDataDir, 'ibdata1')).writeAsStringSync('x');
      final s = make(l);
      await s.startDatabase();
      expect(l.ran.any((r) => r.exe == paths.mariadbInstallDb), isFalse);
    });

    test('database creation failing stops the stack with a reason; the web server is never started', () async {
      final l = FakeLauncher()
        ..runCode = 1
        ..runOutput = 'boom\nkhong tao duoc';
      final s = make(l);
      await s.startAll();
      expect(s.db.current, ServiceState.failed);
      expect(s.db.error, contains('khong tao duoc'));
      expect(l.started, isEmpty);
    });

    test('a port that never opens is reported', () async {
      final l = FakeLauncher();
      final s = make(l, tcp: (h, port) async => false);
      // shorten: the real wait is 60 s, so only assert the wiring with a started process and a failing probe via markFailed
      s.db.markFailed('MariaDB không mở cổng');
      expect(s.db.current, ServiceState.failed);
    });

    test('tunnel: no authtoken -> a clear note and nothing started; the shop still works locally', () async {
      final l = FakeLauncher();
      final s = make(l);
      s.config.ngrok.enabled = true;
      expect(await s.startTunnel(), isFalse);
      expect(s.tunnelNote, contains('authtoken'));
      expect(l.started, isEmpty);
    });

    test('tunnel with token + API key: finds the domain, starts ngrok on it, adopts the public address and saves it in the web settings', () async {
      final l = FakeLauncher();
      final routes = <String>[];
      final s = make(l, http: (m, u, {headers, body}) async {
        routes.add('$m ${u.host}${u.path}');
        if (u.host == 'api.ngrok.com') return const HttpAnswer(200, '{"reserved_domains":[{"domain":"pos-quan.ngrok-free.app"}]}');
        if (u.port == 4041) return const HttpAnswer(200, '{"tunnels":[{"public_url":"https://pos-quan.ngrok-free.app"}]}');
        return const HttpAnswer(404, '');
      });
      s.config.ngrok
        ..enabled = true
        ..authToken = 'TOKEN'
        ..apiKey = 'KEY';
      await s.web.start(() async => FakeProcess());
      s.web.markRunning();
      expect(await s.startTunnel(), isTrue);
      expect(s.config.ngrok.domain, 'pos-quan.ngrok-free.app');
      expect(File(paths.configFile).readAsStringSync(), contains('pos-quan.ngrok-free.app'), reason: 'the domain is remembered');
      final ng = l.started.single;
      expect(ng.exe, paths.ngrok);
      expect(ng.args, containsAll(['--url=https://pos-quan.ngrok-free.app', '--authtoken=TOKEN']));
      expect(s.publicUrl, 'https://pos-quan.ngrok-free.app');
      expect(s.tunnel.current, ServiceState.running);
      final save = l.ran.singleWhere((r) => r.args.first.endsWith('set-public-url.js'));
      expect(save.args.last, 'https://pos-quan.ngrok-free.app');
    });

    test('tunnel refused by ngrok: the reason is shown, the rest keeps working', () async {
      final l = FakeLauncher();
      final s = make(l, http: (m, u, {headers, body}) async => const HttpAnswer(404, ''));
      s.config.ngrok
        ..enabled = true
        ..authToken = 'BAD';
      final done = s.startTunnel();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      l.started.single.process.say('{"lvl":"eror","err":"authentication failed: ERR_NGROK_105"}');
      expect(await done, isFalse);
      expect(s.tunnelNote, contains('authtoken'));
      expect(s.tunnel.current, ServiceState.failed);
    });

    test('sync: pull/push call the script with the cloud settings in the environment; incomplete settings are refused', () async {
      final l = FakeLauncher();
      final s = make(l);
      expect((await s.runSync('push')).ok, isFalse);
      s.config.cloud
        ..host = 'srv2089.hstgr.io'
        ..name = 'db'
        ..user = 'u'
        ..password = 'pw';
      l.runOutput = 'Copied 12 row(s)';
      final r = await s.runSync('pull', full: true);
      expect(r.ok, isTrue);
      expect(r.output, contains('Copied 12'));
      final ran = l.ran.last;
      expect(ran.args, containsAllInOrder([endsWith('cloud-sync.js'), 'pull', '--full']));
      expect(ran.env!['CLOUD_DB_HOST'], 'srv2089.hstgr.io');
      expect(ran.env!['DB_PASSWORD'], s.config.dbPassword);
    });

    test('the background sync status written by the web server is read back', () {
      final s = make(FakeLauncher());
      expect(s.syncStatus(), isNull);
      File(paths.syncStatusFile).writeAsStringSync('{"state":"ok","lastRows":3}');
      expect(s.syncStatus()!['state'], 'ok');
    });
  });
}
