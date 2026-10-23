import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:sqflite/sqflite.dart';

/// The shop of "Dùng trên máy này": a blank SQLite database on the phone (no server, no account anywhere else).
/// Only what the local mode serves is stored: the menu, the orders with their lines and payments, the admin account
/// and a few settings (meta). [LocalBackend] answers the app's API calls from it.
///
/// Times are stored as UTC ISO-8601 strings (like the JSON API) next to `created_ms` for filtering by shop day.
class LocalDb {
  /// The file at [path], opened with [factory] (sqflite on the phone, sqflite_common_ffi in tests).
  LocalDb(this.factory, this.path);

  final DatabaseFactory factory;
  final String path;
  Future<Database>? _db;

  static const fileName = 'local_shop.db';
  static const version = 1;

  /// Opens (creating it if needed) the file on first use.
  Future<Database> database() => _db ??= factory
          .openDatabase(path, options: OpenDatabaseOptions(version: version, singleInstance: false, onCreate: (db, _) => _create(db)))
          .catchError((Object e) {
        _db = null; // a locked or full disk now is not forever: the next call tries again
        throw e;
      });

  static Future<void> _create(Database db) async {
    for (final sql in _schema) {
      await db.execute(sql);
    }
  }

  static const _schema = [
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, '
        "role TEXT NOT NULL DEFAULT 'admin', salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
    'CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, '
        'sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1)',
    'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, sku TEXT NOT NULL UNIQUE, '
        'name TEXT NOT NULL, price REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT NOT NULL, status TEXT NOT NULL, '
        "payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_method TEXT, subtotal REAL NOT NULL DEFAULT 0, "
        'discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, note TEXT, created_by INTEGER, '
        'created_at TEXT NOT NULL, created_ms INTEGER NOT NULL, completed_at TEXT, completed_ms INTEGER, paid_at TEXT, cancelled_at TEXT)',
    'CREATE INDEX orders_created ON orders (created_ms DESC)',
    'CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, '
        'product_name TEXT NOT NULL, unit_price REAL NOT NULL, quantity INTEGER NOT NULL, line_total REAL NOT NULL, note TEXT)',
    'CREATE INDEX order_items_order ON order_items (order_id)',
    'CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, method TEXT NOT NULL, '
        'amount REAL NOT NULL, tendered REAL, reference TEXT, received_by INTEGER, paid_at TEXT NOT NULL)',
  ];

  Future<String?> meta(String key) async {
    final rows = await (await database()).query('meta', where: 'key = ?', whereArgs: [key], limit: 1);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  Future<void> setMeta(String key, String? value, [DatabaseExecutor? tx]) async =>
      (tx ?? await database()).insert('meta', {'key': key, 'value': value}, conflictAlgorithm: ConflictAlgorithm.replace);

  /// Has the setup screen run? (A shop name and an admin account exist.)
  Future<bool> isSetUp() async {
    final db = await database();
    return (Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM users')) ?? 0) > 0;
  }

  /// First run of "Dùng trên máy này": the shop's name, its admin account and, when [sampleMenu], a small menu to
  /// try the POS with. Refuses when a shop already exists.
  Future<void> setUp({
    required String shopName,
    required String fullName,
    required String username,
    required String password,
    bool sampleMenu = false,
    DateTime? now,
  }) async {
    final db = await database();
    final at = (now ?? DateTime.now()).toUtc().toIso8601String();
    await db.transaction((tx) async {
      if ((Sqflite.firstIntValue(await tx.rawQuery('SELECT COUNT(*) FROM users')) ?? 0) > 0) {
        throw StateError('Máy này đã có dữ liệu quán.');
      }
      final salt = newSalt();
      await tx.insert('users', {
        'username': username.trim().toLowerCase(),
        'full_name': fullName.trim(),
        'role': 'admin',
        'salt': salt,
        'password_hash': hashPassword(password, salt),
        'created_at': at,
      });
      await setMeta('shop.name', shopName.trim(), tx);
      await setMeta('created_at', at, tx);
      final drinks = await tx.insert('categories', {'code': 'do-uong', 'name': 'Đồ uống', 'sort_order': 1, 'is_active': 1});
      if (sampleMenu) {
        final food = await tx.insert('categories', {'code': 'do-an', 'name': 'Đồ ăn vặt', 'sort_order': 2, 'is_active': 1});
        for (final (cat, sku, name, price) in [
          (drinks, 'CF-DEN', 'Cà phê đen', 20000),
          (drinks, 'CF-SUA', 'Cà phê sữa', 25000),
          (drinks, 'BAC-XIU', 'Bạc xỉu', 29000),
          (drinks, 'TRA-DAO', 'Trà đào', 30000),
          (drinks, 'NUOC-CAM', 'Nước cam', 30000),
          (food, 'HAT-HD', 'Hạt hướng dương', 15000),
          (food, 'BANH-MI', 'Bánh mì que', 12000),
        ]) {
          await tx.insert('products', {'category_id': cat, 'sku': sku, 'name': name, 'price': price, 'is_active': 1, 'created_at': at});
        }
      }
    });
  }

  /// Closes the file and forgets the connection (before the file is deleted).
  Future<void> close() async {
    final pending = _db;
    _db = null;
    if (pending == null) return;
    try {
      await (await pending).close();
    } catch (_) {
      // never opened: nothing to close
    }
  }

  /// "Xóa toàn bộ dữ liệu trên máy": closes the file and deletes it. The next use starts a blank shop.
  Future<void> wipe() async {
    await close();
    await factory.deleteDatabase(path);
  }

  static String newSalt([Random? random]) {
    final r = random ?? Random.secure();
    return base64Url.encode(List<int>.generate(16, (_) => r.nextInt(256)));
  }

  /// Salted, iterated SHA-256: the password never sits on the phone in clear (the file is in the app's private storage).
  static String hashPassword(String password, String salt, {int rounds = 20000}) {
    var digest = sha256.convert(utf8.encode('$salt:$password')).bytes;
    for (var i = 1; i < rounds; i++) {
      digest = sha256.convert([...digest, ...utf8.encode(salt)]).bytes;
    }
    return base64Url.encode(digest);
  }
}
