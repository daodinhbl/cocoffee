import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;

/// Where things live. [installDir] holds the program (manager, runtime\node|mariadb|ngrok, server); [dataDir] (normally
/// %ProgramData%\TasotekPOS) holds everything that must survive an update: the database files, the settings, logs, uploads.
class InstallPaths {
  InstallPaths({required this.installDir, required this.dataDir});

  factory InstallPaths.detect() {
    final exe = Platform.resolvedExecutable;
    // ...\POS Tasotek Server\manager\pos_tasotek_server.exe  ->  install dir is the parent of "manager"
    final dir = p.dirname(exe);
    final install = p.basename(dir).toLowerCase() == 'manager' ? p.dirname(dir) : dir;
    final data = Platform.environment['TASOTEK_DATA_DIR'] ?? p.join(Platform.environment['ProgramData'] ?? r'C:\ProgramData', 'TasotekPOS');
    return InstallPaths(installDir: Platform.environment['TASOTEK_INSTALL_DIR'] ?? install, dataDir: data);
  }

  final String installDir;
  final String dataDir;

  String get node => p.join(installDir, 'runtime', 'node', 'node.exe');
  String get ngrok => p.join(installDir, 'runtime', 'ngrok', 'ngrok.exe');
  String get mariadbDir => p.join(installDir, 'runtime', 'mariadb');
  String get mariadbd => p.join(mariadbDir, 'bin', 'mariadbd.exe');
  String get mariadbInstallDb => p.join(mariadbDir, 'bin', 'mariadb-install-db.exe');
  String get mariadbClient => p.join(mariadbDir, 'bin', 'mariadb.exe');
  String get serverDir => p.join(installDir, 'server');
  String get serverEntry => p.join(serverDir, 'app.js');

  String get configFile => p.join(dataDir, 'config.json');
  String get dbDataDir => p.join(dataDir, 'mariadb-data');
  String get dbConfigFile => p.join(dataDir, 'db-config.json');
  String get logsDir => p.join(dataDir, 'logs');
  String get backupsDir => p.join(dataDir, 'backups');
  String get exportsDir => p.join(dataDir, 'exports');
  String get syncStatusFile => p.join(dataDir, 'cloud-sync-status.json');
  String get ngrokConfig => p.join(dataDir, 'ngrok.yml');
}

class NgrokConfig {
  NgrokConfig({this.enabled = true, this.authToken = '', this.apiKey = '', this.domain = ''});

  factory NgrokConfig.fromJson(Map<String, dynamic> j) => NgrokConfig(
        enabled: j['enabled'] != false,
        authToken: '${j['authToken'] ?? ''}',
        apiKey: '${j['apiKey'] ?? ''}',
        domain: '${j['domain'] ?? ''}',
      );

  bool enabled;

  /// The agent token (dashboard > Your Authtoken): lets this PC open tunnels on the owner's account.
  String authToken;

  /// An ngrok API key (dashboard > API): only used to list / create the account's reserved domain automatically.
  String apiKey;

  /// The reserved ("static") domain, e.g. quan-cua-toi.ngrok-free.app, so the address never changes between restarts.
  String domain;

  Map<String, dynamic> toJson() => {'enabled': enabled, 'authToken': authToken, 'apiKey': apiKey, 'domain': domain};
}

class CloudConfig {
  CloudConfig({this.enabled = false, this.host = '', this.port = 3306, this.name = '', this.user = '', this.password = '', this.minutes = 5});

  factory CloudConfig.fromJson(Map<String, dynamic> j) => CloudConfig(
        enabled: j['enabled'] == true,
        host: '${j['host'] ?? ''}',
        port: (j['port'] as num?)?.toInt() ?? 3306,
        name: '${j['name'] ?? ''}',
        user: '${j['user'] ?? ''}',
        password: '${j['password'] ?? ''}',
        minutes: (j['minutes'] as num?)?.toInt() ?? 5,
      );

  bool enabled;
  String host, name, user, password;
  int port, minutes;

  bool get complete => host.isNotEmpty && name.isNotEmpty && user.isNotEmpty && password.isNotEmpty;

  Map<String, dynamic> toJson() => {'enabled': enabled, 'host': host, 'port': port, 'name': name, 'user': user, 'password': password, 'minutes': minutes};
}

/// Settings of this installation (data\config.json). The database passwords are generated once and never shown.
class AppConfig {
  AppConfig({
    this.shopName = 'Quán của tôi',
    this.serverPort = 3000,
    this.dbPort = 3307,
    this.dbName = 'pos',
    this.dbUser = 'pos',
    required this.dbPassword,
    required this.dbRootPassword,
    NgrokConfig? ngrok,
    CloudConfig? cloud,
    this.autoStartServices = true,
    this.installToken = '',
    this.firstRunAt = '',
    this.lastSeenAt = '',
    this.licenseCode = '',
    this.updateServer = 'https://cocoffee.tasotek-giaiphapso.com',
    this.autoUpdateCheck = true,
  })  : ngrok = ngrok ?? NgrokConfig(),
        cloud = cloud ?? CloudConfig();

  factory AppConfig.fresh([Random? random]) => AppConfig(dbPassword: randomSecret(random: random), dbRootPassword: randomSecret(random: random), installToken: randomSecret(length: 12, random: random));

  factory AppConfig.fromJson(Map<String, dynamic> j) => AppConfig(
        shopName: '${j['shopName'] ?? 'Quán của tôi'}',
        serverPort: (j['serverPort'] as num?)?.toInt() ?? 3000,
        dbPort: (j['dbPort'] as num?)?.toInt() ?? 3307,
        dbName: '${j['dbName'] ?? 'pos'}',
        dbUser: '${j['dbUser'] ?? 'pos'}',
        dbPassword: '${j['dbPassword'] ?? randomSecret()}',
        dbRootPassword: '${j['dbRootPassword'] ?? randomSecret()}',
        ngrok: NgrokConfig.fromJson(Map<String, dynamic>.from(j['ngrok'] as Map? ?? const {})),
        cloud: CloudConfig.fromJson(Map<String, dynamic>.from(j['cloud'] as Map? ?? const {})),
        autoStartServices: j['autoStartServices'] != false,
        installToken: '${j['installToken'] ?? ''}',
        firstRunAt: '${j['firstRunAt'] ?? ''}',
        lastSeenAt: '${j['lastSeenAt'] ?? ''}',
        licenseCode: '${j['licenseCode'] ?? ''}',
        updateServer: '${j['updateServer'] ?? 'https://cocoffee.tasotek-giaiphapso.com'}',
        autoUpdateCheck: j['autoUpdateCheck'] != false,
      );

  String shopName;
  int serverPort;
  int dbPort;
  String dbName, dbUser, dbPassword, dbRootPassword;
  NgrokConfig ngrok;
  CloudConfig cloud;
  bool autoStartServices;

  /// Asked on the web setup page (/cai-dat) so nobody else on the network can claim a fresh box before the owner does.
  String installToken;

  /// Licence: when this installation first ran (starts the trial), the latest time the manager saw (catches a clock set back),
  /// and the vendor's activation code once entered (core/license.dart).
  String firstRunAt, lastSeenAt, licenseCode;

  /// Where new versions of this program come from (the vendor's site, GET /download/windows/manifest.json) and whether to look by itself.
  String updateServer;
  bool autoUpdateCheck;

  Map<String, dynamic> toJson() => {
        'shopName': shopName, 'serverPort': serverPort, 'dbPort': dbPort, 'dbName': dbName, 'dbUser': dbUser, 'dbPassword': dbPassword,
        'dbRootPassword': dbRootPassword, 'ngrok': ngrok.toJson(), 'cloud': cloud.toJson(), 'autoStartServices': autoStartServices, 'installToken': installToken,
        'firstRunAt': firstRunAt, 'lastSeenAt': lastSeenAt, 'licenseCode': licenseCode, 'updateServer': updateServer, 'autoUpdateCheck': autoUpdateCheck,
      };
}

const _alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/// A random secret without look-alike characters (no 0/O, 1/l/I).
String randomSecret({int length = 24, Random? random}) {
  final r = random ?? Random.secure();
  return List.generate(length, (_) => _alphabet[r.nextInt(_alphabet.length)]).join();
}

/// Reads and writes data\config.json (atomic write).
class ConfigStore {
  ConfigStore(this.paths);
  final InstallPaths paths;

  AppConfig loadOrCreate() {
    final f = File(paths.configFile);
    if (f.existsSync()) {
      try {
        return AppConfig.fromJson(Map<String, dynamic>.from(jsonDecode(f.readAsStringSync()) as Map));
      } catch (_) {
        f.copySync('${paths.configFile}.broken-${DateTime.now().millisecondsSinceEpoch}'); // keep what was there, start clean
      }
    }
    final c = AppConfig.fresh()..firstRunAt = DateTime.now().toUtc().toIso8601String();
    save(c);
    return c;
  }

  void save(AppConfig c) {
    final f = File(paths.configFile);
    f.parent.createSync(recursive: true);
    final tmp = File('${paths.configFile}.tmp');
    tmp.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(c.toJson()), flush: true);
    tmp.renameSync(paths.configFile);
  }
}
