import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'config.dart';
import 'env_builder.dart';
import 'license.dart';
import 'ngrok.dart';
import 'supervisor.dart';

typedef TcpProbe = Future<bool> Function(String host, int port);
typedef HealthProbe = Future<bool> Function(int port);

Future<bool> realTcpProbe(String host, int port) async {
  try {
    final s = await Socket.connect(host, port, timeout: const Duration(seconds: 1));
    s.destroy();
    return true;
  } catch (_) {
    return false;
  }
}

Future<bool> realHealthProbe(int port) async {
  try {
    final r = await realHttp('GET', Uri.parse('http://127.0.0.1:$port/health'));
    return r.status == 200;
  } catch (_) {
    return false;
  }
}

/// Starts, watches and stops the three programs of a shop box, in order: MariaDB (the shop's own database), the web server
/// (the POS and its Web Admin, which also serves the mobile app), and the ngrok tunnel (the public address). Also runs the
/// copy to / from Hostinger and keeps the public address saved in the web server's settings.
class StackController {
  StackController({
    required this.paths,
    required this.store,
    required this.config,
    ProcessLauncher? launcher,
    this.http = realHttp,
    this.tcp = realTcpProbe,
    this.health = realHealthProbe,
    this.pollEvery = const Duration(milliseconds: 500),
    this.licenseCheck,
  }) : launcher = launcher ?? RealLauncher() {
    db = ManagedService('mariadb', onLine: _log);
    web = ManagedService('web', restartOnExit: true, onLine: _log);
    tunnel = ManagedService('ngrok', restartOnExit: true, onLine: _log);
  }

  final InstallPaths paths;
  final ConfigStore store;
  AppConfig config;
  final ProcessLauncher launcher;
  final HttpCall http;
  final TcpProbe tcp;
  final HealthProbe health;
  final Duration pollEvery;

  /// Works out the licence status (core/license.dart); null = no licensing (tests). Services only start while it allows them.
  final Future<LicenseStatus> Function()? licenseCheck;
  LicenseStatus? license;

  late final ManagedService db, web, tunnel;

  /// The id of this PC (core/machine_id.dart), null when it could not be read.
  String? machineId;

  final events = StreamController<String>.broadcast();
  final List<String> allLog = [];

  /// The public https address once the tunnel is up (or the last one that was).
  String publicUrl = '';
  String? tunnelNote;

  void _log(String line) {
    allLog.add(line);
    if (allLog.length > 1000) allLog.removeRange(0, allLog.length - 1000);
    events.add(line);
    try {
      Directory(paths.logsDir).createSync(recursive: true);
      File('${paths.logsDir}${Platform.pathSeparator}manager.log').writeAsStringSync('${DateTime.now().toIso8601String()} $line\n', mode: FileMode.append);
    } catch (_) {/* a log must never stop the stack */}
  }

  String get localUrl => 'http://127.0.0.1:${config.serverPort}';

  Future<bool> _waitFor(Future<bool> Function() probe, {Duration timeout = const Duration(seconds: 90)}) async {
    final end = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(end)) {
      if (await probe()) return true;
      await Future<void>.delayed(pollEvery);
    }
    return false;
  }

  // ---------------------------------------------------------------- database
  /// Creates the database files (first run only), starts MariaDB and makes sure the shop's database and user exist.
  Future<bool> startDatabase() async {
    final c = config;
    if (!Directory(paths.dbDataDir).existsSync() || Directory(paths.dbDataDir).listSync().isEmpty) {
      _log('[mariadb] tạo cơ sở dữ liệu lần đầu…');
      Directory(paths.dbDataDir).createSync(recursive: true);
      final r = await launcher.run(paths.mariadbInstallDb, ['--datadir=${paths.dbDataDir}', '--password=${c.dbRootPassword}', '--port=${c.dbPort}']);
      if (r.code != 0) {
        db.markFailed('Không tạo được cơ sở dữ liệu cục bộ: ${r.output.trim().split('\n').last}');
        return false;
      }
    }
    await db.start(() => launcher.start(paths.mariadbd, mariadbArgs(c, paths)));
    if (db.current == ServiceState.failed) return false;
    if (!await _waitFor(() => tcp('127.0.0.1', c.dbPort), timeout: const Duration(seconds: 60))) {
      db.markFailed('MariaDB không mở cổng ${c.dbPort} (cổng đang bị chương trình khác dùng?).');
      return false;
    }
    final p = await launcher.run(paths.mariadbClient, ['-h', '127.0.0.1', '-P', '${c.dbPort}', '-u', 'root', '--batch', '-e', provisionSql(c)], env: {'MYSQL_PWD': c.dbRootPassword});
    if (p.code != 0) {
      db.markFailed('Không tạo được tài khoản CSDL cho ứng dụng: ${p.output.trim().split('\n').last}');
      return false;
    }
    db.markRunning();
    return true;
  }

  // ---------------------------------------------------------------- web server
  Map<String, String> _nodeEnv() => {...Platform.environment, ...serverEnv(config, paths, publicUrl: publicUrl)};

  Future<bool> startWeb() async {
    await web.start(() => launcher.start(paths.node, [paths.serverEntry], env: _nodeEnv(), workingDir: paths.serverDir));
    if (web.current == ServiceState.failed) return false;
    if (!await _waitFor(() => health(config.serverPort), timeout: const Duration(seconds: 120))) {
      web.markFailed('Máy chủ web không trả lời (xem nhật ký).');
      return false;
    }
    web.markRunning();
    return true;
  }

  // ---------------------------------------------------------------- tunnel
  /// Finds/creates the reserved domain (when an API key is set), starts the ngrok agent, waits for its public address and saves
  /// that address in the web server's settings. Never fails the rest of the stack: the shop works on the local network without it.
  Future<bool> startTunnel() async {
    final n = config.ngrok;
    tunnelNote = null;
    if (!n.enabled) return false;
    if (n.authToken.isEmpty) {
      tunnelNote = 'Chưa nhập authtoken ngrok nên chưa có địa chỉ công khai (ứng dụng điện thoại vẫn dùng được trong cùng mạng Wi-Fi).';
      return false;
    }
    try {
      if (n.apiKey.isNotEmpty && n.domain.isEmpty) {
        n.domain = await pickDomain(NgrokApi(n.apiKey, http: http), current: n.domain, shopName: config.shopName);
        store.save(config);
        _log('[ngrok] tên miền: ${n.domain}');
      }
    } on NgrokException catch (e) {
      tunnelNote = e.message;
      return false;
    } catch (e) {
      tunnelNote = 'Không gọi được ngrok API: $e';
      return false;
    }
    File(paths.ngrokConfig).parent.createSync(recursive: true);
    if (!File(paths.ngrokConfig).existsSync()) File(paths.ngrokConfig).writeAsStringSync('version: "3"\nagent:\n  web_addr: 127.0.0.1:4041\n');
    var failure = '';
    tunnel.onLineHook = (l) {
      final e = ngrokErrorFromLog(l);
      if (e != null) failure = e;
    };
    await tunnel.start(() => launcher.start(paths.ngrok, ngrokArgs(port: config.serverPort, configFile: paths.ngrokConfig, domain: n.domain, authToken: n.authToken)));
    String? url;
    final ok = await _waitFor(() async {
      if (failure.isNotEmpty) return true;
      try {
        url = publicUrlFromTunnels((await http('GET', Uri.parse('http://127.0.0.1:4041/api/tunnels'))).body);
      } catch (_) {/* agent not up yet */}
      return url != null;
    }, timeout: const Duration(seconds: 40));
    if (!ok || url == null) {
      tunnelNote = failure.isNotEmpty ? failure : 'ngrok chưa mở được tunnel (xem nhật ký).';
      tunnel.markFailed(tunnelNote!);
      return false;
    }
    tunnel.markRunning();
    await adoptPublicUrl(url!);
    return true;
  }

  /// Remembers the public address and saves it in the web server's settings (so QR codes, Zalo and bill pictures point at it).
  Future<void> adoptPublicUrl(String url) async {
    final changed = url != publicUrl;
    publicUrl = url;
    if (!changed || web.current != ServiceState.running) return;
    final r = await launcher.run(paths.node, ['${paths.serverDir}${Platform.pathSeparator}scripts${Platform.pathSeparator}set-public-url.js', url], env: _nodeEnv(), workingDir: paths.serverDir);
    _log('[ngrok] địa chỉ công khai: $url${r.code == 0 ? '' : ' (chưa lưu được vào Cài đặt: ${r.output.trim()})'}');
  }

  // ---------------------------------------------------------------- everything
  /// Re-evaluates the licence and stops everything if it no longer allows running (expired while the PC stayed on).
  Future<bool> recheckLicense() async {
    final check = licenseCheck;
    if (check == null) return true;
    license = await check();
    if (!license!.allowed) {
      _log('[giấy phép] ${license!.message}');
      if (db.isActive || web.isActive || tunnel.isActive) await stopAll();
      return false;
    }
    return true;
  }

  Future<void> startAll() async {
    if (!await recheckLicense()) return;
    if (!await startDatabase()) return;
    if (!await startWeb()) return;
    unawaited(startTunnel());
  }

  Future<void> stopAll() async {
    await tunnel.stop();
    await web.stop();
    await db.stop();
  }

  Future<void> restartWeb() async {
    await web.stop();
    await startWeb();
  }

  // ---------------------------------------------------------------- Hostinger copy
  /// `push` (local -> Hostinger) or `pull` (Hostinger -> local, first run). [dryRun] only counts. Returns the script's output.
  Future<({bool ok, String output})> runSync(String direction, {bool dryRun = false, bool full = false}) async {
    final c = config.cloud;
    if (!c.complete) return (ok: false, output: 'Chưa nhập đủ thông tin CSDL Hostinger.');
    final env = {..._nodeEnv(), 'CLOUD_DB_HOST': c.host, 'CLOUD_DB_PORT': '${c.port}', 'CLOUD_DB_NAME': c.name, 'CLOUD_DB_USER': c.user, 'CLOUD_DB_PASSWORD': c.password};
    final script = '${paths.serverDir}${Platform.pathSeparator}scripts${Platform.pathSeparator}cloud-sync.js';
    final r = await launcher.run(paths.node, [script, direction, if (dryRun) '--dry-run', if (full) '--full'], env: env, workingDir: paths.serverDir, timeout: const Duration(minutes: 30));
    return (ok: r.code == 0, output: r.output.trim());
  }

  /// The last result of the background copy (written by the web server).
  Map<String, dynamic>? syncStatus() {
    try {
      return jsonDecode(File(paths.syncStatusFile).readAsStringSync()) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  void dispose() => events.close();
}
