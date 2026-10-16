import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart' as fmt;
import '../../core/session.dart';
import '../../core/widgets/common.dart' show Tone;
import '../menu/menu_models.dart' show MenuCategory, foldVi;

/// Most lines the server accepts in one recipe (MAX_RECIPE_LINES in src/services/menuRules.js).
const kMaxRecipeLines = 50;

/// Largest quantity of one ingredient the server accepts (max 1e7 in menuRules.mergeRecipe).
const kMaxRecipeQty = 10000000.0;

num _num(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
bool _flag(Object? v, {bool absent = true}) => v == null ? absent : (v == true || v == 1 || v == '1' || v == 'true');
List<Map<String, dynamic>> _rows(Object? v) => [for (final r in (v is List ? v : const [])) if (r is Map) Map<String, dynamic>.from(r)];

/// Margin band of the web (marginTone in src/utils/viewHelpers.js): >= 65% good, 55-65% worth a look, below that low.
Tone marginTone(num margin) => margin >= 65 ? Tone.good : (margin >= 55 ? Tone.warn : Tone.bad);

/// One ingredient line of a row of GET /api/admin/bom: { ref, name, unit, qty, cost }. MySQL DECIMALs may come as strings.
class BomIngredient {
  const BomIngredient({required this.ref, required this.name, required this.unit, required this.qty, required this.cost});

  factory BomIngredient.fromJson(Map<String, dynamic> j) => BomIngredient(
        ref: _int(j['ref']),
        name: '${j['name'] ?? ''}',
        unit: '${j['unit'] ?? ''}',
        qty: _num(j['qty']).toDouble(),
        cost: _num(j['cost']).toDouble(),
      );

  /// inventory_items.id
  final int ref;
  final String name;
  final String unit;
  final double qty;

  /// qty x current average cost of the ingredient.
  final double cost;

  /// "Cà phê bột 18g" like the web's badge.
  String get label => '$name ${fmt.qty(qty)}$unit';
}

/// Row of productModel.listWithCost(): a menu product with its cost lines, COGS and margin.
class BomRow {
  const BomRow({
    required this.id,
    required this.categoryId,
    required this.categoryName,
    required this.sku,
    required this.name,
    required this.price,
    required this.isDirect,
    required this.imageUrl,
    required this.ingredients,
    required this.cogs,
    required this.margin,
  });

  factory BomRow.fromJson(Map<String, dynamic> j) {
    final ingredients = [for (final r in _rows(j['ingredients'])) BomIngredient.fromJson(r)];
    final price = _num(j['price']);
    final cogs = j['cogs'] != null ? _num(j['cogs']).toDouble() : ingredients.fold<double>(0, (s, g) => s + g.cost);
    final margin = j['margin'] != null ? _num(j['margin']).toDouble() : (price > 0 ? (price - cogs) / price * 100 : 0.0);
    return BomRow(
      id: _int(j['id']),
      categoryId: _int(j['category_id']),
      categoryName: '${j['category_name'] ?? ''}',
      sku: '${j['sku'] ?? ''}',
      name: '${j['name'] ?? ''}',
      price: price,
      isDirect: '${j['stock_mode'] ?? 'bom'}' == 'direct',
      imageUrl: j['image_url'] == null ? null : '${j['image_url']}',
      ingredients: ingredients,
      cogs: cogs,
      margin: margin,
    );
  }

  final int id;
  final int categoryId;
  final String categoryName;
  final String sku;
  final String name;
  final num price;

  /// stock_mode 'direct' (retail, 1:1 with one stock item) - edited in Thực đơn, not here.
  final bool isDirect;
  final String? imageUrl;
  final List<BomIngredient> ingredients;
  final double cogs;

  /// (price - cogs) / price in percent, 0 when the price is 0.
  final double margin;

  /// No recipe (or, for retail, no linked stock item): the cost is not known, so the margin means nothing.
  bool get missing => ingredients.isEmpty;

  /// A row without a recipe is never "good": its COGS is 0, which would show a flattering 100%.
  Tone get tone => missing ? Tone.warn : marginTone(margin);

  String get marginText => missing ? '—' : fmt.pct(margin);
}

/// Active inventory item the recipe editor can pick: raw material with its current average cost per base unit.
class CatalogItem {
  const CatalogItem({required this.id, required this.name, required this.unit, required this.unitCost, required this.active});

  factory CatalogItem.fromJson(Map<String, dynamic> j) => CatalogItem(
        id: _int(j['id']),
        name: '${j['name'] ?? ''}',
        unit: '${j['unit'] ?? ''}',
        unitCost: _num(j['unitCost']).toDouble(),
        active: _flag(j['active']),
      );

  final int id;
  final String name;
  final String unit;
  final double unitCost;
  final bool active;

  /// Inactive items are offered only to a line that already uses one (web: "(ngưng dùng)").
  String get label => active ? name : '$name (ngưng dùng)';
}

class BomStats {
  const BomStats({required this.total, required this.missing, required this.avgMargin});

  final int total;
  final int missing;
  final double avgMargin;
}

class BomData {
  const BomData({required this.drinks, required this.retail, required this.stats, required this.categories, required this.catalog});

  /// GET /api/admin/bom -> { drinks, retail, stats: { total, missing, avgMargin }, categories, catalog }.
  factory BomData.fromJson(Map<String, dynamic> j) {
    final drinks = [for (final r in _rows(j['drinks'])) BomRow.fromJson(r)];
    final retail = [for (final r in _rows(j['retail'])) BomRow.fromJson(r)];
    final all = [...drinks, ...retail];
    final s = j['stats'] is Map ? Map<String, dynamic>.from(j['stats'] as Map) : const <String, dynamic>{};
    return BomData(
      drinks: drinks,
      retail: retail,
      stats: BomStats(
        total: s['total'] != null ? _int(s['total']) : all.length,
        missing: s['missing'] != null ? _int(s['missing']) : all.where((r) => r.missing).length,
        avgMargin: s['avgMargin'] != null
            ? _num(s['avgMargin']).toDouble()
            : (all.isEmpty ? 0 : all.fold<double>(0, (t, r) => t + r.margin) / all.length),
      ),
      categories: [for (final r in _rows(j['categories'])) MenuCategory.fromJson(r)],
      catalog: [for (final r in _rows(j['catalog'])) CatalogItem.fromJson(r)],
    );
  }

  final List<BomRow> drinks;
  final List<BomRow> retail;
  final BomStats stats;
  final List<MenuCategory> categories;
  final List<CatalogItem> catalog;
}

Duration? _noRetry(int _, Object _) => null;

/// GET /api/admin/bom (admin only; the API enforces it).
final bomDataProvider = FutureProvider.autoDispose<BomData>((ref) async {
  final api = ref.watch(apiProvider);
  return BomData.fromJson(await api.get('/admin/bom'));
}, retry: _noRetry);

/// Web filter: every visible cell of the row (name, SKU, group, ingredients), accents and case ignored.
bool bomMatches(BomRow r, String query) {
  final q = foldVi(query.trim());
  if (q.isEmpty) return true;
  final hay = foldVi([
    r.name,
    r.sku,
    r.categoryName,
    if (r.missing) 'chưa có định mức',
    for (final g in r.ingredients) g.label,
  ].join(' '));
  return hay.contains(q);
}

// ------------------------------------------------------------------------------------------------ recipe editing

/// Typed quantity, Vietnamese or English style ("0,25", "0.25", "18"); null when it is not a number.
double? parseQty(String raw) {
  final s = raw.trim().replaceAll(',', '.');
  if (s.isEmpty) return null;
  final v = double.tryParse(s);
  return v == null || v.isNaN || v.isInfinite ? null : v;
}

/// Quantity for a text field: 18 -> "18", 0.25 -> "0.25", 0.0125 -> "0.0125" (up to 4 decimals, no trailing zeros).
String plainQty(num v) {
  final s = v.toDouble().toStringAsFixed(4).replaceFirst(RegExp(r'\.?0+$'), '');
  return s.isEmpty ? '0' : s;
}

/// The server stores 4 decimals (menuRules.mergeRecipe).
double roundQty(double v) => (v * 10000).round() / 10000;

/// One validated recipe line.
class RecipeLine {
  const RecipeLine(this.ref, this.quantity);

  final int ref;
  final double quantity;

  /// Request body line: whole quantities as integers (18, not 18.0).
  Map<String, Object> toJson() =>
      {'inventory_item_id': ref, 'quantity': quantity == quantity.roundToDouble() ? quantity.toInt() : quantity};
}

/// Duplicate lines of one ingredient are summed (the server does the same), in first-seen order, 4 decimals.
List<RecipeLine> mergeLines(Iterable<RecipeLine> lines) {
  final sums = <int, double>{};
  for (final l in lines) {
    sums[l.ref] = (sums[l.ref] ?? 0) + l.quantity;
  }
  return [for (final e in sums.entries) RecipeLine(e.key, roundQty(e.value))];
}
