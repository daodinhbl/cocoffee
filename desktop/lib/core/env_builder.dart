import 'config.dart';

/// The environment the web server (Node) is started with. Everything the shop's box needs is here, so the server itself needs no
/// .env file: the local MariaDB, where its files go (they must survive an update), the setup-page token, the Hostinger copy.
Map<String, String> serverEnv(AppConfig c, InstallPaths paths, {String publicUrl = ''}) {
  final env = <String, String>{
    'NODE_ENV': 'production',
    'PORT': '${c.serverPort}',
    'DB_HOST': '127.0.0.1',
    'DB_PORT': '${c.dbPort}',
    'DB_NAME': c.dbName,
    'DB_USER': c.dbUser,
    'DB_PASSWORD': c.dbPassword,
    'DB_POOL_LIMIT': '10',
    // an empty database gets its tables at the first start, and the owner creates the account on the web setup page
    'AUTO_BOOTSTRAP_DB': 'true',
    'SEED_DEMO': 'false',
    'SEED_MENU': 'false',
    'INSTALL_WIZARD': 'true',
    'INSTALL_TOKEN': c.installToken,
    'SHOP_NAME': c.shopName,
    'SERVICE_MANAGED': '1', // the manager starts the server again when it exits (Cài đặt > Khởi động lại)
    'DB_CONFIG_FILE': paths.dbConfigFile,
    'BACKUP_DIR': paths.backupsDir,
    'TAX_EXPORT_DIR': paths.exportsDir,
    'CLOUD_SYNC_STATUS_FILE': paths.syncStatusFile,
  };
  if (publicUrl.isNotEmpty) env['PUBLIC_BASE_URL'] = publicUrl;
  final k = c.cloud;
  if (k.enabled && k.complete) {
    env['CLOUD_SYNC_ENABLED'] = 'true';
    env['CLOUD_DB_HOST'] = k.host;
    env['CLOUD_DB_PORT'] = '${k.port}';
    env['CLOUD_DB_NAME'] = k.name;
    env['CLOUD_DB_USER'] = k.user;
    env['CLOUD_DB_PASSWORD'] = k.password;
    env['CLOUD_SYNC_MINUTES'] = '${k.minutes < 1 ? 5 : k.minutes}';
  }
  return env;
}

/// Arguments of mariadbd. Listens on the loopback only: nothing else on the network can reach the shop's database.
List<String> mariadbArgs(AppConfig c, InstallPaths paths) => [
      '--no-defaults',
      '--datadir=${paths.dbDataDir}',
      '--port=${c.dbPort}',
      '--bind-address=127.0.0.1',
      '--console',
      '--character-set-server=utf8mb4',
      '--collation-server=utf8mb4_unicode_ci',
      '--default-time-zone=+07:00',
      '--innodb-buffer-pool-size=128M',
      '--max-connections=60',
      '--skip-name-resolve',
    ];

/// First-time database setup, as SQL for the `mariadb` client connected as root: the shop's database and its user (loopback only).
String provisionSql(AppConfig c) {
  String lit(String s) => "'${s.replaceAll(r'\', r'\\').replaceAll("'", "''")}'";
  final db = '`${c.dbName.replaceAll('`', '')}`';
  return 'CREATE DATABASE IF NOT EXISTS $db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n'
      "CREATE USER IF NOT EXISTS ${lit(c.dbUser)}@'127.0.0.1' IDENTIFIED BY ${lit(c.dbPassword)};\n"
      "ALTER USER ${lit(c.dbUser)}@'127.0.0.1' IDENTIFIED BY ${lit(c.dbPassword)};\n"
      "GRANT ALL PRIVILEGES ON $db.* TO ${lit(c.dbUser)}@'127.0.0.1';\n"
      'FLUSH PRIVILEGES;\n';
}
