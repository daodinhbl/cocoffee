import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
int? _intOrNull(Object? v) => v == null ? null : (v is num ? v.toInt() : int.tryParse('$v'));
num _num(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
bool _flag(Object? v, {bool absent = true}) => v == null ? absent : (v == true || v == 1 || v == '1' || v == 'true');
String? _strOrNull(Object? v) => v == null ? null : '$v';
List<Map<String, dynamic>> _rows(Object? v) => [for (final r in (v is List ? v : const [])) if (r is Map) Map<String, dynamic>.from(r)];

/// Row of productModel.listForAdmin() (GET /api/admin/menu) or of GET /api/products (no aliases there).
class MenuProduct {
  const MenuProduct({
    required this.id,
    required this.categoryId,
    required this.categoryName,
    required this.sku,
    required this.name,
    required this.price,
    required this.stockMode,
    required this.inventoryItemId,
    required this.inventoryItemName,
    required this.isActive,
    required this.imageUrl,
    required this.aliases,
  });

  factory MenuProduct.fromJson(Map<String, dynamic> j) => MenuProduct(
        id: _int(j['id']),
        categoryId: _int(j['category_id']),
        categoryName: '${j['category_name'] ?? ''}',
        sku: '${j['sku'] ?? ''}',
        name: '${j['name'] ?? ''}',
        price: _num(j['price']),
        stockMode: '${j['stock_mode'] ?? 'bom'}',
        inventoryItemId: _intOrNull(j['inventory_item_id']),
        inventoryItemName: _strOrNull(j['inventory_item_name']),
        isActive: _flag(j['is_active']),
        imageUrl: _strOrNull(j['image_url']),
        aliases: j['aliases'] is List ? [for (final a in j['aliases'] as List) '$a'] : null,
      );

  final int id;
  final int categoryId;
  final String categoryName;
  final String sku;
  final String name;
  final num price;
  final String stockMode;
  final int? inventoryItemId;
  final String? inventoryItemName;
  final bool isActive;
  final String? imageUrl;

  /// Chat keywords (the name is always one of them); null when the list endpoint did not send them.
  final List<String>? aliases;

  bool get isBom => stockMode == 'bom';

  /// Keywords other than the name, as the web shows them under the SKU.
  List<String> get extraAliases => [for (final a in aliases ?? const <String>[]) if (a != name) a];

  /// Web label of stock_mode.
  String get modeLabel => isBom ? 'Pha chế (BOM)' : 'Bán lẻ';

  MenuProduct withItemName(String? itemName) => MenuProduct(
        id: id, categoryId: categoryId, categoryName: categoryName, sku: sku, name: name, price: price, stockMode: stockMode,
        inventoryItemId: inventoryItemId, inventoryItemName: itemName, isActive: isActive, imageUrl: imageUrl, aliases: aliases,
      );
}

/// categoryModel.list({ activeOnly: false }) row.
class MenuCategory {
  const MenuCategory({required this.id, required this.code, required this.name, required this.sortOrder, required this.isActive});

  factory MenuCategory.fromJson(Map<String, dynamic> j) => MenuCategory(
        id: _int(j['id']),
        code: '${j['code'] ?? ''}',
        name: '${j['name'] ?? ''}',
        sortOrder: _int(j['sort_order']),
        isActive: _flag(j['is_active']),
      );

  final int id;
  final String code;
  final String name;
  final int sortOrder;
  final bool isActive;
}

/// Active inventory item offered in "Hàng trong kho (chỉ hàng bán lẻ)".
class StockOption {
  const StockOption({required this.id, required this.name, required this.unit});

  factory StockOption.fromJson(Map<String, dynamic> j) =>
      StockOption(id: _int(j['id']), name: '${j['name'] ?? ''}', unit: '${j['unit'] ?? ''}');

  final int id;
  final String name;
  final String unit;
}

class MenuData {
  const MenuData({required this.products, required this.categories, required this.items});

  /// GET /api/admin/menu -> { products, categories, items }.
  factory MenuData.fromAdmin(Map<String, dynamic> res) => MenuData(
        products: [for (final r in _rows(res['products'])) MenuProduct.fromJson(r)],
        categories: [for (final r in _rows(res['categories'])) MenuCategory.fromJson(r)],
        items: [for (final r in _rows(res['items'])) if (_flag(r['is_active'])) StockOption.fromJson(r)],
      );

  /// Fallback from GET /api/products, /api/categories and /api/inventory: the stock item name is joined here,
  /// aliases stay unknown (loaded per product when editing). Order like listForAdmin: active first.
  factory MenuData.fromLists(Map<String, dynamic> products, Map<String, dynamic> categories, Map<String, dynamic> inventory) {
    final items = [for (final r in _rows(inventory['items'])) if (_flag(r['is_active'])) StockOption.fromJson(r)];
    final names = {for (final i in items) i.id: i.name};
    MenuProduct joined(MenuProduct p) =>
        p.inventoryItemName == null && p.inventoryItemId != null ? p.withItemName(names[p.inventoryItemId]) : p;
    final list = [for (final r in _rows(products['products'])) joined(MenuProduct.fromJson(r))];
    return MenuData(
      products: [...list.where((p) => p.isActive), ...list.where((p) => !p.isActive)],
      categories: [for (final r in _rows(categories['categories'])) MenuCategory.fromJson(r)],
      items: items,
    );
  }

  final List<MenuProduct> products;
  final List<MenuCategory> categories;
  final List<StockOption> items;
}

Duration? _noRetry(int _, Object _) => null;

/// Admins: GET /api/admin/menu; if the server does not have it yet (404), the three public lists.
/// Cashiers (read-only view): GET /api/products, /api/categories, /api/inventory.
final menuDataProvider = FutureProvider.autoDispose<MenuData>((ref) async {
  final api = ref.watch(apiProvider);
  final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
  if (admin) {
    try {
      return MenuData.fromAdmin(await api.get('/admin/menu'));
    } on ApiException catch (e) {
      if (e.status != 404) rethrow;
    }
  }
  final all = admin ? <String, dynamic>{'all': 1} : null;
  final res = await Future.wait([
    api.get('/products', query: all),
    api.get('/categories', query: all),
    api.get('/inventory'),
  ]);
  return MenuData.fromLists(res[0], res[1], res[2]);
}, retry: _noRetry);

/// Text of the "Tìm theo tên, SKU, từ khóa…" box.
final menuQueryProvider = NotifierProvider.autoDispose<MenuQuery, String>(MenuQuery.new);

class MenuQuery extends Notifier<String> {
  @override
  String build() => '';

  void set(String value) => state = value;
}

const _accents = {
  'a': 'àáạảãâầấậẩẫăằắặẳẵ',
  'e': 'èéẹẻẽêềếệểễ',
  'i': 'ìíịỉĩ',
  'o': 'òóọỏõôồốộổỗơờớợởỡ',
  'u': 'ùúụủũưừứựửữ',
  'y': 'ỳýỵỷỹ',
  'd': 'đ',
};

final Map<int, String> _fold = {
  for (final e in _accents.entries)
    for (final r in e.value.runes) r: e.key,
};

/// Lowercase without Vietnamese accents, like norm() in public/admin/admin.js ("Bạc xỉu" -> "bac xiu").
String foldVi(String s) {
  final out = StringBuffer();
  for (final r in s.toLowerCase().runes) {
    out.write(_fold[r] ?? String.fromCharCode(r));
  }
  return out.toString();
}

/// Web filter: every visible cell of the row except the actions.
bool productMatches(MenuProduct p, String query) {
  final q = foldVi(query.trim());
  if (q.isEmpty) return true;
  final hay = foldVi([
    p.name, p.sku, ...p.extraAliases, p.categoryName, p.modeLabel, p.inventoryItemName ?? '',
    p.isActive ? 'Đang bán' : 'Ngừng bán',
  ].join(' '));
  return hay.contains(q);
}

/// Textarea "a, b\nc" -> ['a', 'b', 'c'] like menu.parseAliases; null when over the web limits.
List<String>? parseAliases(String raw) {
  final list = raw.split(RegExp(r'[\n,;]+')).map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
  if (list.length > 30 || list.any((a) => a.length > 100)) return null;
  return list;
}
