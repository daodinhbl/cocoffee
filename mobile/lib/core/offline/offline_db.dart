import 'dart:convert';

import 'package:sqflite/sqflite.dart';

/// Lower-cases and strips Vietnamese diacritics so "ca phe" finds "Cà phê" (the server's utf8mb4_unicode_ci
/// collation does the same for its LIKE searches).
String foldVi(String input) {
  const from = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
  const to = 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';
  final b = StringBuffer();
  for (final r in input.toLowerCase().runes) {
    final ch = String.fromCharCode(r);
    final i = from.indexOf(ch);
    b.write(i >= 0 ? to[i] : ch);
  }
  return b.toString();
}

double _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}') ?? 0;
int _flag(Object? v) => (v == true || v == 1 || v == '1') ? 1 : 0;

/// Milliseconds since epoch of a server timestamp (ISO-8601 from the JSON API); 0 when missing.
int msOf(Object? v) => DateTime.tryParse('${v ?? ''}')?.millisecondsSinceEpoch ?? 0;

/// The app's offline database (SQLite): a copy of the shop's data taken from GET /api/sync/snapshot, plus the local
/// effects of writes still waiting in the outbox. Rows keep the server's JSON in `data` (so a screen gets exactly the
/// shape the API returns) next to a few indexed columns used to filter, search and sort without a connection.
///
/// [OfflineDb.disabled] is used where there is no storage (tests, unsupported platforms): every read is empty.
class OfflineDb {
  OfflineDb(Future<Database> Function() open) : _open = open;
  OfflineDb.disabled() : _open = null;

  final Future<Database> Function()? _open;
  Future<Database?>? _db;

  static const version = 1;

  bool get enabled => _open != null;

  /// The open database, or null when disabled or when SQLite cannot be opened (never throws).
  Future<Database?> database() {
    final open = _open;
    if (open == null) return Future.value(null);
    return _db ??= () async {
      try {
        return await open();
      } catch (_) {
        _db = null; // a locked or full disk now is not forever: the next call tries again
        return null;
      }
    }();
  }

  /// Opens (creating it if needed) the file at [path] with [factory].
  static Future<Database> openAt(DatabaseFactory factory, String path, {bool singleInstance = true}) => factory.openDatabase(
        path,
        options: OpenDatabaseOptions(version: version, singleInstance: singleInstance, onCreate: (db, _) => _create(db)),
      );

  static Future<void> _create(Database db) async {
    for (final sql in _schema) {
      await db.execute(sql);
    }
  }

  static const _schema = [
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE categories (id INTEGER PRIMARY KEY, sort INTEGER, is_active INTEGER, data TEXT NOT NULL)',
    'CREATE TABLE products (id INTEGER PRIMARY KEY, category_id INTEGER, name_norm TEXT, is_active INTEGER, data TEXT NOT NULL)',
    'CREATE TABLE tables (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER, data TEXT NOT NULL)',
    'CREATE TABLE inventory (id INTEGER PRIMARY KEY, name_norm TEXT, is_active INTEGER, is_low INTEGER, data TEXT NOT NULL)',
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, name_norm TEXT, phone TEXT, zalo TEXT, balance REAL, updated_ms INTEGER, data TEXT NOT NULL)',
    'CREATE INDEX customers_updated ON customers (updated_ms DESC)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, code TEXT, status TEXT, source TEXT, payment_status TEXT, table_id INTEGER, '
        'customer_id INTEGER, created_ms INTEGER, total REAL, data TEXT NOT NULL)',
    'CREATE INDEX orders_created ON orders (created_ms DESC)',
  ];

  // ----------------------------------------------------------------------------------------------- meta

  Future<String?> meta(String key) async {
    final db = await database();
    if (db == null) return null;
    final rows = await db.query('meta', where: 'key = ?', whereArgs: [key], limit: 1);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  Future<void> setMeta(String key, String? value) async {
    final db = await database();
    if (db == null) return;
    await db.insert('meta', {'key': key, 'value': value}, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<Object?> metaJson(String key) async {
    final raw = await meta(key);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } catch (_) {
      return null;
    }
  }

  /// When the snapshot was taken on the server; null if the app has never synced.
  Future<DateTime?> syncedAt() async => DateTime.tryParse(await meta('synced_at') ?? '');

  /// Is there anything to answer from? (A snapshot was stored.)
  Future<bool> get hasData async => (await meta('synced_at')) != null;

  // -------------------------------------------------------------------------------------------- snapshot

  static List<Map<String, dynamic>> _maps(Object? v) =>
      [for (final e in (v as List? ?? const [])) if (e is Map) Map<String, dynamic>.from(e)];

  /// Replaces the whole local copy with [s] (the body of GET /api/sync/snapshot) in one transaction. Collections
  /// the snapshot does not carry (a cashier gets no customer list) are left as they are. False when there is no
  /// database to write to.
  Future<bool> replaceSnapshot(Map<String, dynamic> s) async {
    final db = await database();
    if (db == null) return false;
    await db.transaction((tx) async {
      final b = tx.batch();

      void replace(String table, Object? source, Map<String, Object?> Function(Map<String, dynamic>) row) {
        if (source == null) return;
        b.delete(table);
        for (final m in _maps(source)) {
          b.insert(table, {...row(m), 'data': jsonEncode(m)});
        }
      }

      replace('categories', s['categories'], (m) => {'id': m['id'], 'sort': m['sort_order'] ?? 0, 'is_active': _flag(m['is_active'])});
      replace('products', s['products'], (m) => {
            'id': m['id'],
            'category_id': m['category_id'],
            'name_norm': foldVi('${m['name'] ?? ''}'),
            'is_active': _flag(m['is_active']),
          });
      replace('tables', s['tables'], (m) => {'id': m['id'], 'code': '${m['code'] ?? ''}', 'is_active': _flag(m['is_active'] ?? 1)});
      final inv = s['inventory'];
      if (inv is Map) {
        replace('inventory', inv['items'], (m) => {
              'id': m['id'],
              'name_norm': foldVi('${m['name'] ?? ''}'),
              'is_active': _flag(m['is_active']),
              'is_low': _flag(m['is_low']),
            });
        b.insert('meta', {'key': 'inventory_stock_value', 'value': inv['stock_value']?.toString()}, conflictAlgorithm: ConflictAlgorithm.replace);
      }
      replace('customers', s['customers'], (m) => {
            'id': m['id'],
            'name_norm': foldVi('${m['name'] ?? ''}'),
            'phone': '${m['phone'] ?? ''}',
            'zalo': '${m['zalo_user_id'] ?? ''}',
            'balance': _num(m['balance']),
            'updated_ms': msOf(m['updated_at']),
          });
      replace('orders', s['orders'], (m) => {
            'id': m['id'],
            'code': '${m['order_code'] ?? ''}',
            'status': '${m['status'] ?? ''}',
            'source': '${m['source'] ?? ''}',
            'payment_status': '${m['payment_status'] ?? ''}',
            'table_id': m['table_id'],
            'customer_id': m['customer_id'],
            'created_ms': msOf(m['created_at']),
            'total': _num(m['total']),
          });

      final ledgers = s['ledgers'];
      if (ledgers is Map) {
        b.delete('meta', where: "key LIKE 'ledger:%'");
        ledgers.forEach((id, rows) => b.insert('meta', {'key': 'ledger:$id', 'value': jsonEncode(rows)}, conflictAlgorithm: ConflictAlgorithm.replace));
      }
      for (final key in const ['drafts', 'printer', 'customer_stats']) {
        if (s[key] != null) b.insert('meta', {'key': key, 'value': jsonEncode(s[key])}, conflictAlgorithm: ConflictAlgorithm.replace);
      }
      b.insert('meta', {'key': 'role', 'value': '${s['role'] ?? ''}'}, conflictAlgorithm: ConflictAlgorithm.replace);
      b.insert('meta', {'key': 'synced_at', 'value': '${s['generated_at'] ?? DateTime.now().toIso8601String()}'},
          conflictAlgorithm: ConflictAlgorithm.replace);
      await b.commit(noResult: true);
    });
    return true;
  }

  /// Row counts for the sync screen.
  Future<Map<String, int>> counts() async {
    final db = await database();
    if (db == null) return const {};
    final out = <String, int>{};
    for (final t in const ['categories', 'products', 'tables', 'inventory', 'customers', 'orders']) {
      out[t] = Sqflite.firstIntValue(await db.rawQuery('SELECT COUNT(*) FROM $t')) ?? 0;
    }
    return out;
  }

  Future<void> clear() async {
    final db = await database();
    if (db == null) return;
    for (final t in const ['categories', 'products', 'tables', 'inventory', 'customers', 'orders', 'meta']) {
      await db.delete(t);
    }
  }
}
