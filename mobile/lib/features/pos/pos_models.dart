import 'dart:math' as math;

import '../../core/api/api_client.dart';

/// Data of the POS screen, read from GET /api/pos/bootstrap, GET /api/zalo/drafts and GET /api/orders/:id
/// (snake_case keys, like src/controllers/admin/pos.js page()). The cart lives only in the app, like the web
/// (public/pos/pos.js): server prices are authoritative, the ones here are for display.

num toNum(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
num? toNumOrNull(Object? v) => v == null ? null : (v is num ? v : num.tryParse('$v'));
int toInt(Object? v) => toNum(v).round();
int? toIntOrNull(Object? v) => toNumOrNull(v)?.round();
String? strOrNull(Object? v) {
  if (v == null) return null;
  final s = '$v'.trim();
  return s.isEmpty ? null : s;
}

List<Map<String, dynamic>> mapList(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const [];

class PosCategory {
  const PosCategory({required this.id, required this.code, required this.name});
  factory PosCategory.fromJson(Map<String, dynamic> j) =>
      PosCategory(id: toInt(j['id']), code: '${j['code'] ?? ''}', name: '${j['name'] ?? ''}');
  final int id;
  final String code;
  final String name;
}

class PosProduct {
  const PosProduct({required this.id, required this.categoryId, required this.name, required this.price, this.imageUrl});
  factory PosProduct.fromJson(Map<String, dynamic> j) => PosProduct(
        id: toInt(j['id']),
        categoryId: toIntOrNull(j['category_id']),
        name: '${j['name'] ?? ''}',
        price: toNum(j['price']),
        imageUrl: strOrNull(j['image_url']),
      );
  final int id;
  final int? categoryId;
  final String name;
  final num price;
  final String? imageUrl;
}

class PosTable {
  const PosTable({required this.id, required this.code, required this.name, required this.status, this.currentOrderId, this.currentOrderTotal});
  factory PosTable.fromJson(Map<String, dynamic> j) => PosTable(
        id: toInt(j['id']),
        code: '${j['code'] ?? ''}',
        name: '${j['name'] ?? ''}',
        status: '${j['status'] ?? 'available'}',
        currentOrderId: toIntOrNull(j['current_order_id']),
        currentOrderTotal: toNumOrNull(j['current_order_total']),
      );
  final int id;
  final String code;
  final String name;
  final String status;
  final int? currentOrderId;
  final num? currentOrderTotal;

  bool get busy => status == 'serving';

  /// "name || code" like the web.
  String get label => name.trim().isNotEmpty ? name : code;
}

/// adminModel.zaloPendingDrafts row: a Zalo draft whose chat session is waiting for the customer's "ok".
class ZaloDraft {
  const ZaloDraft({required this.id, this.chatType, this.lastActivityAt, this.expiresAt, this.orderId, this.orderCode, required this.total});
  factory ZaloDraft.fromJson(Map<String, dynamic> j) => ZaloDraft(
        id: toInt(j['id']),
        chatType: strOrNull(j['chat_type']),
        lastActivityAt: strOrNull(j['last_activity_at']),
        expiresAt: strOrNull(j['expires_at']),
        orderId: toIntOrNull(j['order_id']),
        orderCode: strOrNull(j['order_code']),
        total: toNum(j['total']),
      );
  final int id;
  final String? chatType;
  final String? lastActivityAt;
  final String? expiresAt;
  final int? orderId;
  final String? orderCode;
  final num total;

  String get chatLabel => chatType == 'group' ? 'Nhóm Zalo' : 'Chat riêng';

  /// Whole minutes left before the draft expires (null when unknown or already expired).
  int? minutesLeft({DateTime? now}) {
    final d = DateTime.tryParse(expiresAt ?? '');
    if (d == null) return null;
    final left = d.difference(now ?? DateTime.now());
    return left.isNegative ? null : (left.inSeconds / 60).ceil();
  }
}

class PosData {
  const PosData({
    required this.categories,
    required this.products,
    required this.tables,
    required this.drafts,
    required this.zaloState,
    required this.zaloLabel,
    required this.autoPrint,
    required this.vatRate,
    required this.paperMm,
  });

  factory PosData.fromJson(Map<String, dynamic> j) {
    final zalo = j['zalo'] is Map ? Map<String, dynamic>.from(j['zalo'] as Map) : const <String, dynamic>{};
    final printer = j['printer'] is Map ? Map<String, dynamic>.from(j['printer'] as Map) : const <String, dynamic>{};
    return PosData(
      categories: [for (final c in mapList(j['categories'])) PosCategory.fromJson(c)],
      products: [for (final p in mapList(j['products'])) PosProduct.fromJson(p)],
      tables: [for (final t in mapList(j['tables'])) PosTable.fromJson(t)],
      drafts: [for (final d in mapList(j['drafts'])) ZaloDraft.fromJson(d)],
      zaloState: '${zalo['state'] ?? 'unknown'}',
      zaloLabel: '${zalo['label'] ?? ''}',
      autoPrint: (printer['autoPrint'] ?? printer['auto_print']) == true,
      vatRate: toNum(printer['vatRate'] ?? printer['vat_rate']),
      paperMm: toInt(printer['paperMm'] ?? printer['paper_mm'] ?? 80),
    );
  }

  final List<PosCategory> categories;
  final List<PosProduct> products;
  final List<PosTable> tables;
  final List<ZaloDraft> drafts;
  final String zaloState;
  final String zaloLabel;
  final bool autoPrint;

  /// Percent; 0 when the printer settings hide VAT (prices include VAT).
  final num vatRate;
  final int paperMm;

  PosProduct? product(int id) {
    for (final p in products) {
      if (p.id == id) return p;
    }
    return null;
  }

  PosTable? table(int? id) {
    if (id == null) return null;
    for (final t in tables) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// 'Tất cả' comes first in the UI; then each category that has at least one active product.
  List<PosCategory> get usedCategories =>
      [for (final c in categories) if (products.any((p) => p.categoryId == c.id)) c];
}

/// One cart line. A product can sit on several lines when they carry different notes (ít đá / không đá).
class CartLine {
  const CartLine({required this.productId, required this.name, required this.price, required this.qty, this.note = '', this.imageUrl});

  factory CartLine.fromOrderItem(Map<String, dynamic> it, PosProduct? p) => CartLine(
        productId: toInt(it['product_id']),
        name: p?.name ?? '${it['product_name'] ?? ''}',
        price: p?.price ?? toNum(it['unit_price']),
        qty: toInt(it['quantity']).clamp(1, kMaxLineQty),
        note: '${it['note'] ?? ''}'.trim(),
        imageUrl: p?.imageUrl,
      );

  final int productId;
  final String name;
  final num price;
  final int qty;
  final String note;
  final String? imageUrl;

  num get total => price * qty;

  CartLine copyWith({int? qty, String? note}) =>
      CartLine(productId: productId, name: name, price: price, qty: qty ?? this.qty, note: note ?? this.note, imageUrl: imageUrl);

  /// Item of POST /api/orders and PUT /api/orders/:id/items.
  Map<String, dynamic> toJson() => {
        'product_id': productId,
        'quantity': qty,
        if (note.isNotEmpty) 'note': note,
      };
}

/// The API accepts 1..99 per line (the web caps the stepper at 99 too).
const kMaxLineQty = 99;

/// Notes are VARCHAR(255) on the server (order note and item note).
const kMaxNote = 255;

class CartState {
  const CartState({
    this.tableId,
    this.orderId,
    this.orderCode,
    this.lines = const [],
    this.discount = 0,
    this.note = '',
    this.busy = false,
    this.dirty = false,
  });

  /// null = takeaway ("Mang đi").
  final int? tableId;

  /// Set when an open order was loaded (a busy table): saving replaces its lines.
  final int? orderId;
  final String? orderCode;
  final List<CartLine> lines;
  final num discount;
  final String note;
  final bool busy;

  /// Changed since it was loaded, saved or emptied.
  final bool dirty;

  int get count => lines.fold(0, (s, l) => s + l.qty);
  num get subtotal => lines.fold<num>(0, (s, l) => s + l.total);

  /// Display clamps the discount to the subtotal, like the web.
  num get discountApplied => math.min(discount, subtotal);
  num get total => subtotal - discountApplied;

  /// Prices include VAT: "of which VAT" = total − total / (1 + rate).
  num vat(num ratePercent) => ratePercent > 0 ? total - total / (1 + ratePercent / 100) : 0;

  int qtyOf(int productId) => lines.where((l) => l.productId == productId).fold(0, (s, l) => s + l.qty);

  bool get isEmpty => lines.isEmpty;

  static const _keep = Object();

  CartState copyWith({
    Object? tableId = _keep,
    Object? orderId = _keep,
    Object? orderCode = _keep,
    List<CartLine>? lines,
    num? discount,
    String? note,
    bool? busy,
    bool? dirty,
  }) =>
      CartState(
        tableId: identical(tableId, _keep) ? this.tableId : tableId as int?,
        orderId: identical(orderId, _keep) ? this.orderId : orderId as int?,
        orderCode: identical(orderCode, _keep) ? this.orderCode : orderCode as String?,
        lines: lines ?? this.lines,
        discount: discount ?? this.discount,
        note: note ?? this.note,
        busy: busy ?? this.busy,
        dirty: dirty ?? this.dirty,
      );
}

/// Result of a successful POST /api/orders/:id/pay.
class PayOutcome {
  const PayOutcome({required this.order, required this.change, this.tableId});
  final Map<String, dynamic> order;
  final num change;
  final int? tableId;
  String get code => '${order['order_code'] ?? ''}';
}

/// What the cashier chose in the pay sheet.
class PayRequest {
  const PayRequest({required this.method, this.tendered, this.discount = 0, this.reference});
  final String method;
  final num? tendered;
  final num discount;
  final String? reference;
}

/// Quick-cash buttons of the web pay dialog: the exact total ('Đủ tiền'), then the total rounded up to 50.000,
/// to 100.000, to 100.000 + 100.000 and 500.000; only values >= total, no duplicates, at most four.
List<num> quickCash(num total) {
  final t = total.round();
  final options = <num>[t, (t / 50000).ceil() * 50000, (t / 100000).ceil() * 100000, (t / 100000).ceil() * 100000 + 100000, 500000];
  final out = <num>[];
  for (final v in options) {
    if (v >= t && !out.contains(v)) out.add(v);
  }
  return out.take(4).toList();
}

const _accentGroups = {
  'a': 'àáạảãâầấậẩẫăằắặẳẵ',
  'e': 'èéẹẻẽêềếệểễ',
  'i': 'ìíịỉĩ',
  'o': 'òóọỏõôồốộổỗơờớợởỡ',
  'u': 'ùúụủũưừứựửữ',
  'y': 'ỳýỵỷỹ',
  'd': 'đ',
};

final Map<int, String> _accentMap = {
  for (final e in _accentGroups.entries)
    for (final r in e.value.runes) r: e.key,
};

/// Accent-insensitive lowercase text for search, like norm() in public/pos/pos.js ("Trà đào" -> "tra dao").
String norm(String s) {
  final out = StringBuffer();
  for (final r in s.toLowerCase().runes) {
    if (r >= 0x0300 && r <= 0x036F) continue; // combining marks (decomposed input)
    out.write(_accentMap[r] ?? String.fromCharCode(r));
  }
  return out.toString();
}

/// Products without a photo get an emoji guessed from the name, same table as the web POS.
const _emoji = <(String, String)>[
  (r'thuoc|555|marlboro|jet', '🚬'),
  (r'bac xiu|sua tuoi|latte', '🥛'),
  (r'ca phe|coffee|espresso|americano|cappuccino', '☕'),
  (r'tra dao|dao', '🍑'),
  (r'tra vai|vai', '🍹'),
  (r'matcha|tra xanh', '🍵'),
  (r'\btra\b', '🍵'),
  (r'cacao|socola|chocolate', '🍫'),
  (r'\bbo\b', '🥑'),
  (r'xoai', '🥭'),
  (r'\bdau\b', '🍓'),
  (r'sinh to|smoothie', '🥤'),
  (r'banh|cake|croissant', '🍰'),
  (r'nuoc ngot|coca|pepsi|sting|7up', '🥤'),
  (r'nuoc|aqua|lavie|suoi', '💧'),
  (r'\bbia\b|beer', '🍺'),
];

String emojiOf(String name) {
  final n = norm(name);
  for (final (pattern, e) in _emoji) {
    if (RegExp(pattern).hasMatch(n)) return e;
  }
  return '☕';
}

/// Avatar letters like the web header chip: first letters of the last two words.
String userInitials(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '?';
  final last = words.length > 2 ? words.sublist(words.length - 2) : words;
  return last.map((w) => String.fromCharCodes(w.runes.take(1))).join().toUpperCase();
}

/// Error codes after which the POS data (tables, menu) is stale and is reloaded.
const staleCodes = {'TABLE_OCCUPIED', 'PRODUCT_UNAVAILABLE', 'ORDER_NOT_OPEN', 'ORDER_NOT_PAYABLE', 'ORDER_NOT_CANCELLABLE', 'NOT_FOUND', 'ORDER_NOT_FOUND'};

bool isStale(Object e) => staleCodes.contains(toApiException(e).code);

/// Vietnamese text for POS errors, like POS_MESSAGES in src/controllers/admin/pos.js. INSUFFICIENT_STOCK and the
/// other codes keep ApiException.message (already Vietnamese).
String posError(Object e) {
  final x = toApiException(e);
  switch (x.code) {
    case 'TABLE_OCCUPIED':
      return 'Bàn này đang có đơn mở. Sơ đồ bàn đã được tải lại, chọn lại bàn để mở đơn hiện tại.';
    case 'PRODUCT_UNAVAILABLE':
      return 'Có món vừa ngừng bán. Thực đơn đã được tải lại, vui lòng kiểm tra giỏ.';
    case 'INSUFFICIENT_PAYMENT':
      return 'Tiền khách đưa chưa đủ.';
    case 'ORDER_NOT_OPEN':
      return 'Đơn không còn mở.';
    case 'ORDER_NOT_PAYABLE':
      return 'Đơn không còn ở trạng thái thanh toán được.';
    case 'ORDER_NOT_CANCELLABLE':
      return 'Đơn này không còn hủy được.';
    case 'EMPTY_ORDER':
      return 'Đơn chưa có món nào.';
    default:
      return x.message;
  }
}
