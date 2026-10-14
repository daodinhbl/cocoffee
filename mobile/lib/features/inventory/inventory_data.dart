import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';

// ---------------------------------------------------------------------------------------------- parsing helpers

double asDouble(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}') ?? 0;
int asInt(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
int? asIntOrNull(Object? v) => v == null ? null : (v is num ? v.toInt() : int.tryParse('$v'));

/// TINYINT(1) flags come back as 0/1; accept booleans too.
bool asFlag(Object? v) => v == true || v == 1 || v == '1' || v == 'true';
String? asText(Object? v) => v == null ? null : '$v';

List<Map<String, dynamic>> asRows(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const [];

/// Number typed by staff, Vietnamese style: "1.234,5", "0,25", "12.5", "1.500" (dots grouping thousands when every
/// group after the first has exactly three digits and the number does not start with "0.").
double? parseAmount(String raw) {
  var s = raw.trim().replaceAll(' ', '');
  if (s.isEmpty) return null;
  if (s.contains(',')) {
    s = s.replaceAll('.', '').replaceAll(',', '.');
  } else if (RegExp(r'^[1-9]\d{0,2}(\.\d{3})+$').hasMatch(s)) {
    s = s.replaceAll('.', '');
  }
  return double.tryParse(s);
}

/// Plain number for a form field ("1500", "0.25"), no grouping, so editing it is unambiguous.
String plainNumber(num v) {
  final s = v.toDouble().toStringAsFixed(3).replaceFirst(RegExp(r'\.?0+$'), '');
  return s.isEmpty ? '0' : s;
}

/// Lower-case without Vietnamese diacritics, like the web's client-side table filter (public/admin/admin.js).
String foldVi(String s) {
  final lower = s.toLowerCase();
  final out = StringBuffer();
  for (final r in lower.runes) {
    final ch = String.fromCharCode(r);
    out.write(_foldMap[ch] ?? ch);
  }
  return out.toString();
}

final Map<String, String> _foldMap = () {
  const groups = {
    'a': 'àáạảãâầấậẩẫăằắặẳẵ',
    'e': 'èéẹẻẽêềếệểễ',
    'i': 'ìíịỉĩ',
    'o': 'òóọỏõôồốộổỗơờớợởỡ',
    'u': 'ùúụủũưừứựửữ',
    'y': 'ỳýỵỷỹ',
    'd': 'đ',
  };
  final m = <String, String>{};
  groups.forEach((base, chars) {
    for (final r in chars.runes) {
      m[String.fromCharCode(r)] = base;
    }
  });
  return m;
}();

// ---------------------------------------------------------------------------------------------- models

/// Row of inventoryModel.listAll() / getById() (GET /api/inventory?all=1, GET /api/inventory/:id `item`).
class InvItem {
  const InvItem({
    required this.id,
    required this.sku,
    required this.name,
    required this.unit,
    required this.quantity,
    required this.avgCost,
    required this.minStock,
    required this.isActive,
    required this.isLow,
    required this.stockValue,
    this.imageUrl,
  });

  factory InvItem.fromJson(Map<String, dynamic> j) {
    final q = asDouble(j['quantity_on_hand']);
    final cost = asDouble(j['avg_cost']);
    final min = asDouble(j['min_stock']);
    return InvItem(
      id: asInt(j['id']),
      sku: '${j['sku'] ?? ''}',
      name: '${j['name'] ?? ''}',
      unit: '${j['unit'] ?? ''}',
      quantity: q,
      avgCost: cost,
      minStock: min,
      isActive: j['is_active'] == null ? true : asFlag(j['is_active']),
      isLow: j['is_low'] == null ? q <= min : asFlag(j['is_low']),
      stockValue: j['stock_value'] == null ? q * cost : asDouble(j['stock_value']),
      imageUrl: asText(j['image_url']),
    );
  }

  final int id;
  final String sku, name, unit;
  final double quantity, avgCost, minStock, stockValue;
  final bool isActive, isLow;
  final String? imageUrl;
}

/// What the list screen shows: every item plus the stock value of the active ones.
class InventoryData {
  const InventoryData(this.items, this.stockValue);
  final List<InvItem> items;
  final double stockValue;

  List<InvItem> get active => [for (final i in items) if (i.isActive) i];
  int get lowCount => active.where((i) => i.isLow).length;
  int get outCount => active.where((i) => i.quantity <= 0).length;
}

/// stockLevel() from src/utils/viewHelpers.js: bar full at 3x the minimum.
class StockLevel {
  const StockLevel(this.fraction, this.tone, this.text);
  final double fraction;
  final Tone tone;
  final String text;

  Color color(BuildContext c) => switch (tone) {
        Tone.good => c.co.good,
        Tone.warn => c.co.warn,
        Tone.bad => c.co.bad,
        _ => c.cs.outline,
      };
}

StockLevel stockLevel(InvItem i) {
  final q = i.quantity, m = i.minStock;
  if (!i.isActive) return const StockLevel(0, Tone.neutral, 'Ngừng dùng');
  if (q <= 0) return const StockLevel(0, Tone.bad, 'Hết hàng');
  if (m > 0 && q <= m) return StockLevel(math.max(4, (q / (m * 3) * 100).round()) / 100, Tone.warn, 'Sắp hết');
  return StockLevel(m > 0 ? math.min(100, (q / (m * 3) * 100).round()) / 100 : 1, Tone.good, 'Đủ');
}

class LastPurchase {
  const LastPurchase({required this.quantity, required this.unitCost, this.createdAt});
  factory LastPurchase.fromJson(Map<String, dynamic> j) =>
      LastPurchase(quantity: asDouble(j['quantity']), unitCost: asDouble(j['unit_cost']), createdAt: asText(j['created_at']));
  final double quantity, unitCost;
  final String? createdAt;
}

/// inventoryModel.usage(id, 30).
class Usage {
  const Usage({this.days = 30, this.used = 0, this.wasted = 0, this.received = 0, this.lastPurchase});
  factory Usage.fromJson(Map<String, dynamic> j) {
    final lp = j['lastPurchase'] ?? j['last_purchase'];
    final days = asInt(j['days']);
    return Usage(
      days: days > 0 ? days : 30,
      used: asDouble(j['used']),
      wasted: asDouble(j['wasted']),
      received: asDouble(j['received']),
      lastPurchase: lp is Map ? LastPurchase.fromJson(Map<String, dynamic>.from(lp)) : null,
    );
  }
  final int days;
  final double used, wasted, received;
  final LastPurchase? lastPurchase;
}

/// inventoryModel.usedIn(id): products consuming the item.
class UsedIn {
  const UsedIn({required this.id, required this.name, required this.isActive, required this.stockMode, required this.quantity, this.imageUrl});
  factory UsedIn.fromJson(Map<String, dynamic> j) => UsedIn(
        id: asInt(j['id']),
        name: '${j['name'] ?? ''}',
        isActive: j['is_active'] == null ? true : asFlag(j['is_active']),
        stockMode: '${j['stock_mode'] ?? 'bom'}',
        quantity: asDouble(j['quantity']),
        imageUrl: asText(j['image_url']),
      );
  final int id;
  final String name, stockMode;
  final bool isActive;
  final double quantity;
  final String? imageUrl;
  bool get direct => stockMode == 'direct';
}

/// inventoryModel.movements(id, 200), newest first.
class Movement {
  const Movement({
    required this.id,
    required this.type,
    required this.change,
    required this.unitCost,
    required this.balanceAfter,
    this.orderId,
    this.note,
    this.createdAt,
    this.createdByName,
  });
  factory Movement.fromJson(Map<String, dynamic> j) => Movement(
        id: asInt(j['id']),
        type: '${j['movement_type'] ?? ''}',
        change: asDouble(j['quantity_change']),
        unitCost: asDouble(j['unit_cost']),
        balanceAfter: asDouble(j['balance_after']),
        orderId: asIntOrNull(j['order_id']),
        note: asText(j['note']),
        createdAt: asText(j['created_at']),
        createdByName: asText(j['created_by_name']),
      );
  final int id;
  final String type;
  final double change, unitCost, balanceAfter;
  final int? orderId;
  final String? note, createdAt, createdByName;
}

/// GET /api/inventory/:id
class InvDetail {
  const InvDetail({required this.item, required this.usage, required this.usedIn, required this.movements});
  factory InvDetail.fromJson(Map<String, dynamic> j) => InvDetail(
        item: InvItem.fromJson(Map<String, dynamic>.from(j['item'] as Map)),
        usage: j['usage'] is Map ? Usage.fromJson(Map<String, dynamic>.from(j['usage'] as Map)) : const Usage(),
        usedIn: asRows(j['used_in']).map(UsedIn.fromJson).toList(),
        movements: asRows(j['movements']).map(Movement.fromJson).toList(),
      );
  final InvItem item;
  final Usage usage;
  final List<UsedIn> usedIn;
  final List<Movement> movements;
}

/// adminModel.recentPurchases(): GET /api/inventory/purchases
class Purchase {
  const Purchase({
    required this.id,
    required this.itemId,
    required this.itemName,
    required this.unit,
    required this.quantity,
    required this.unitCost,
    this.note,
    this.createdAt,
    this.userName,
  });
  factory Purchase.fromJson(Map<String, dynamic> j) => Purchase(
        id: asInt(j['id']),
        itemId: asInt(j['inventory_item_id']),
        itemName: '${j['item_name'] ?? ''}',
        unit: '${j['unit'] ?? ''}',
        quantity: asDouble(j['quantity_change']),
        unitCost: asDouble(j['unit_cost']),
        note: asText(j['note']),
        createdAt: asText(j['created_at']),
        userName: asText(j['user_name']),
      );
  final int id, itemId;
  final String itemName, unit;
  final double quantity, unitCost;
  final String? note, createdAt, userName;
}

/// Ledger movement types, in the web's order (MOVEMENT_TYPES) with the same labels, icons and tones.
const movementTypes = ['purchase', 'sale', 'adjustment', 'waste', 'return'];

typedef MoveMeta = ({String label, IconData icon, Tone tone});

MoveMeta moveMeta(String type) => switch (type) {
      'purchase' => (label: 'Nhập kho', icon: Icons.upload_rounded, tone: Tone.good),
      'sale' => (label: 'Bán hàng', icon: Icons.receipt_long_rounded, tone: Tone.info),
      'adjustment' => (label: 'Kiểm kê', icon: Icons.tune_rounded, tone: Tone.warn),
      'waste' => (label: 'Hao hụt', icon: Icons.delete_outline_rounded, tone: Tone.bad),
      'return' => (label: 'Trả hàng', icon: Icons.keyboard_double_arrow_left_rounded, tone: Tone.neutral),
      _ => (label: type, icon: Icons.inventory_2_outlined, tone: Tone.neutral),
    };

// ---------------------------------------------------------------------------------------------- providers

/// Admin: GET /api/inventory?all=1 (inactive included, stock_value, image_url). Cashier: GET /api/inventory (active only;
/// the all=1 variant is admin-only), stock value computed here.
final inventoryListProvider = FutureProvider.autoDispose<InventoryData>((ref) async {
  final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
  final res = await ref.read(apiProvider).get('/inventory', query: admin ? {'all': '1'} : null);
  final items = asRows(res['items']).map(InvItem.fromJson).toList();
  final total = res['stock_value'] != null
      ? asDouble(res['stock_value'])
      : items.where((i) => i.isActive).fold<double>(0, (s, i) => s + i.stockValue);
  return InventoryData(items, total);
});

class InventoryFilter {
  const InventoryFilter({this.lowOnly = false, this.query = ''});
  final bool lowOnly;
  final String query;
}

/// List filters: the "Tất cả / Sắp hết" pills and the name/SKU search.
class InventoryFilterNotifier extends Notifier<InventoryFilter> {
  @override
  InventoryFilter build() => const InventoryFilter();

  void setLowOnly(bool v) => state = InventoryFilter(lowOnly: v, query: state.query);
  void setQuery(String q) => state = InventoryFilter(lowOnly: state.lowOnly, query: q);
}

final inventoryFilterProvider = NotifierProvider.autoDispose<InventoryFilterNotifier, InventoryFilter>(InventoryFilterNotifier.new);

/// GET /api/inventory/:id -> { item, usage, used_in, movements }
final inventoryDetailProvider = FutureProvider.autoDispose.family<InvDetail, int>((ref, id) async {
  return InvDetail.fromJson(await ref.read(apiProvider).get('/inventory/$id'));
});

/// Ledger type pill on the item page (null = "Tất cả").
class LedgerTypeNotifier extends Notifier<String?> {
  LedgerTypeNotifier(this.itemId);
  final int itemId;

  @override
  String? build() => null;

  void select(String? type) => state = type;
}

final ledgerTypeProvider = NotifierProvider.autoDispose.family<LedgerTypeNotifier, String?, int>(LedgerTypeNotifier.new);

/// Receiving picker: GET /api/inventory (active items).
final receivingItemsProvider = FutureProvider.autoDispose<List<InvItem>>((ref) async {
  final res = await ref.read(apiProvider).get('/inventory');
  return asRows(res['items']).map(InvItem.fromJson).toList();
});

/// GET /api/inventory/purchases?limit=30 (the web shows the last 30).
final purchasesProvider = FutureProvider.autoDispose<List<Purchase>>((ref) async {
  final res = await ref.read(apiProvider).get('/inventory/purchases', query: {'limit': '30'});
  return asRows(res['purchases']).map(Purchase.fromJson).toList();
});

/// After any stock write: every inventory read is stale.
void invalidateInventory(WidgetRef ref) {
  ref.invalidate(inventoryListProvider);
  ref.invalidate(inventoryDetailProvider);
  ref.invalidate(receivingItemsProvider);
  ref.invalidate(purchasesProvider);
}
