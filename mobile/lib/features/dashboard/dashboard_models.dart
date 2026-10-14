import '../../core/format.dart';
import '../../core/widgets/common.dart';

/// Data of the Tổng quan screen, read from the snake_case JSON of GET /api/admin/dashboard,
/// GET /api/admin/notifications and GET /api/zalo/status. Labels and rules are the Web Admin ones
/// (src/controllers/admin/dashboard.js, src/controllers/admin/common.js, views/pages/dashboard.ejs).

num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
num? _nn(Object? v) => v == null ? null : (v is num ? v : num.tryParse('$v'));
int _i(Object? v) => _n(v).toInt();
String _s(Object? v) => v == null ? '' : '$v';
String? _so(Object? v) {
  if (v == null) return null;
  final s = '$v';
  return s.isEmpty ? null : s;
}

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : const {};
List<Map<String, dynamic>> _list(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const [];

/// orderModel.summary(): { orders, revenue, cogs, gross_profit, unpaid } over completed orders of a day.
class DaySummary {
  const DaySummary({this.orders = 0, this.revenue = 0, this.cogs = 0, this.grossProfit = 0, this.unpaid = 0});

  factory DaySummary.fromJson(Map<String, dynamic> j) => DaySummary(
        orders: _i(j['orders']),
        revenue: _n(j['revenue']),
        cogs: _n(j['cogs']),
        grossProfit: _n(j['gross_profit']),
        unpaid: _n(j['unpaid']),
      );

  final int orders;
  final num revenue;
  final num cogs;
  final num grossProfit;
  final num unpaid;
}

/// adminModel.queueCounts(): live Zalo drafts, open (serving) orders, completed-but-unpaid orders.
class QueueCounts {
  const QueueCounts({this.drafts = 0, this.openOrders = 0, this.unpaid = 0});

  factory QueueCounts.fromJson(Map<String, dynamic> j) =>
      QueueCounts(drafts: _i(j['drafts']), openOrders: _i(j['open_orders']), unpaid: _i(j['unpaid']));

  final int drafts;
  final int openOrders;
  final int unpaid;
}

/// ORDER_STATUS / orderStatusBadge(o) in viewHelpers.js.
(String, Tone) orderStatusLabel(String status, String? paymentStatus) {
  if (status == 'completed' && paymentStatus == 'unpaid') return ('Chờ thu tiền', Tone.warn);
  return switch (status) {
    'draft' => ('Chờ khách xác nhận', Tone.warn),
    'open' => ('Đang phục vụ', Tone.info),
    'completed' => ('Hoàn tất', Tone.good),
    'cancelled' => ('Đã hủy', Tone.neutral),
    _ => (status, Tone.neutral),
  };
}

/// sourceBadge(source)
(String, Tone) sourceLabel(String? source) => source == 'zalo' ? ('Zalo', Tone.info) : ('POS', Tone.neutral);

/// One of the 5 recent orders (orderModel.list row).
class RecentOrder {
  const RecentOrder({
    required this.id,
    required this.orderCode,
    required this.source,
    required this.status,
    this.paymentStatus,
    required this.total,
    this.createdAt,
  });

  factory RecentOrder.fromJson(Map<String, dynamic> j) => RecentOrder(
        id: _i(j['id']),
        orderCode: _s(j['order_code']),
        source: _s(j['source']),
        status: _s(j['status']),
        paymentStatus: _so(j['payment_status']),
        total: _n(j['total']),
        createdAt: _so(j['created_at']),
      );

  final int id;
  final String orderCode;
  final String source;
  final String status;
  final String? paymentStatus;
  final num total;
  final String? createdAt;

  (String, Tone) get statusLabel => orderStatusLabel(status, paymentStatus);
  (String, Tone) get sourceBadge => sourceLabel(source);
}

/// Ingredient under its minimum. `ratio` = quantity_on_hand / min_stock (0 when there is no minimum).
class LowStockItem {
  const LowStockItem({required this.id, required this.name, required this.unit, required this.quantity, required this.minStock, required this.ratio});

  factory LowStockItem.fromJson(Map<String, dynamic> j) {
    final q = _n(j['quantity_on_hand'] ?? j['qty']);
    final min = _n(j['min_stock'] ?? j['min']);
    return LowStockItem(
      id: _i(j['id']),
      name: _s(j['name']),
      unit: _s(j['unit']),
      quantity: q,
      minStock: min,
      ratio: _nn(j['ratio']) ?? (min > 0 ? q / min : 0),
    );
  }

  final int id;
  final String name;
  final String unit;
  final num quantity;
  final num minStock;
  final num ratio;

  /// Width of the "Cảnh báo tồn kho thấp" bar in %: qty/min clamped to 0..100 (red below 60).
  int get barPercent => minStock > 0 ? ((quantity / minStock) * 100).round().clamp(0, 100) : 0;
}

/// Completed sales of one hour (06..22).
class HourSales {
  const HourSales({required this.hour, required this.revenue, required this.orders});

  factory HourSales.fromJson(Map<String, dynamic> j) =>
      HourSales(hour: _i(j['hour']), revenue: _n(j['revenue']), orders: _i(j['orders']));

  final int hour;
  final num revenue;
  final int orders;
}

/// The 17 bars of "Doanh thu theo giờ": hours 6..22, empty hours filled so the chart keeps its shape.
List<HourSales> fillHours(List<HourSales> rows) => [
      for (var h = 6; h <= 22; h++)
        rows.firstWhere((r) => r.hour == h, orElse: () => HourSales(hour: h, revenue: 0, orders: 0)),
    ];

class BestSeller {
  const BestSeller({required this.productId, required this.name, required this.qty, required this.revenue});

  factory BestSeller.fromJson(Map<String, dynamic> j) => BestSeller(
        productId: _i(j['product_id']),
        name: _s(j['product_name'] ?? j['name']),
        qty: _n(j['qty']),
        revenue: _n(j['revenue']),
      );

  final int productId;
  final String name;
  final num qty;
  final num revenue;
}

/// Stock value (quantity x moving-average cost); `cover` = quantity / min_stock, null without a minimum.
class OverstockItem {
  const OverstockItem({required this.id, required this.name, required this.unit, required this.qty, required this.value, this.cover});

  factory OverstockItem.fromJson(Map<String, dynamic> j) => OverstockItem(
        id: _i(j['id']),
        name: _s(j['name']),
        unit: _s(j['unit']),
        qty: _n(j['qty']),
        value: _n(j['value']),
        cover: _nn(j['cover']),
      );

  final int id;
  final String name;
  final String unit;
  final num qty;
  final num value;
  final num? cover;
}

/// Customer with Zalo orders delivered but not paid.
class Debtor {
  const Debtor({this.customerId, this.customerName, this.phone, this.zaloUserId, required this.orders, required this.amount, this.oldest});

  factory Debtor.fromJson(Map<String, dynamic> j) => Debtor(
        customerId: _nn(j['customer_id'])?.toInt(),
        customerName: _so(j['customer_name']),
        phone: _so(j['customer_phone']),
        zaloUserId: _so(j['zalo_user_id']),
        orders: _i(j['orders']),
        amount: _n(j['amount']),
        oldest: _so(j['oldest']),
      );

  final int? customerId;
  final String? customerName;
  final String? phone;
  final String? zaloUserId;
  final int orders;
  final num amount;
  final String? oldest;

  /// customer_name || 'Khách Zalo …{last 4 of zalo_user_id}'
  String get who {
    if (customerName != null && customerName!.trim().isNotEmpty) return customerName!;
    final z = zaloUserId ?? '';
    return 'Khách Zalo …${z.length > 4 ? z.substring(z.length - 4) : z}';
  }
}

/// GET /api/admin/dashboard
class DashboardData {
  const DashboardData({
    required this.day,
    required this.today,
    required this.yesterday,
    required this.margin,
    required this.counts,
    required this.recentOrders,
    required this.lowStock,
    this.lowStockCount,
    required this.hourly,
    required this.bestSellers,
    required this.overstock,
    required this.debtors,
    required this.fetchedAt,
  });

  factory DashboardData.fromJson(Map<String, dynamic> j, {DateTime? fetchedAt}) {
    final today = DaySummary.fromJson(_map(j['today']));
    final low = [for (final r in _list(j['low_stock'])) LowStockItem.fromJson(r)]..sort((a, b) => a.ratio.compareTo(b.ratio));
    return DashboardData(
      day: _s(j['day']),
      today: today,
      yesterday: DaySummary.fromJson(_map(j['yesterday'])),
      margin: _nn(j['margin']) ?? (today.revenue > 0 ? today.grossProfit / today.revenue * 100 : 0),
      counts: QueueCounts.fromJson(_map(j['counts'])),
      recentOrders: [for (final r in _list(j['recent_orders'])) RecentOrder.fromJson(r)],
      lowStock: low,
      lowStockCount: _nn(j['low_stock_count'])?.toInt(),
      hourly: fillHours([for (final r in _list(j['hourly'])) HourSales.fromJson(r)]),
      bestSellers: [for (final r in _list(j['best_sellers'])) BestSeller.fromJson(r)],
      overstock: [for (final r in _list(j['overstock'])) OverstockItem.fromJson(r)],
      debtors: [for (final r in _list(j['debtors'])) Debtor.fromJson(r)],
      fetchedAt: fetchedAt ?? DateTime.now(),
    );
  }

  final String day;
  final DaySummary today;
  final DaySummary yesterday;
  final num margin;
  final QueueCounts counts;
  final List<RecentOrder> recentOrders;
  final List<LowStockItem> lowStock;

  /// Optional total of low-stock items when the server sends it (low_stock itself is capped at 8).
  final int? lowStockCount;
  final List<HourSales> hourly;
  final List<BestSeller> bestSellers;
  final List<OverstockItem> overstock;
  final List<Debtor> debtors;
  final DateTime fetchedAt;
}

/// revenueDelta() in dashboard.js: "+12,4% so với hôm qua" / "−3,0% so với hôm qua" / "Hôm qua chưa có doanh thu".
(String, Tone) revenueDelta(num now, num before) {
  if (!(before > 0)) return ('Hôm qua chưa có doanh thu', Tone.neutral);
  final change = (now - before) / before * 100;
  return ('${change >= 0 ? '+' : '−'}${pct(change.abs())} so với hôm qua', change >= 0 ? Tone.good : Tone.warn);
}

/// Shop clock (UTC+7) regardless of the device zone.
DateTime shopNow([DateTime? now]) => (now ?? DateTime.now()).toUtc().add(const Duration(hours: 7));

/// Greeting by shop hour: <11 sáng, <14 trưa, <18 chiều, else tối.
String greeting(int hour) => hour < 11
    ? 'Chào buổi sáng'
    : hour < 14
        ? 'Chào buổi trưa'
        : hour < 18
            ? 'Chào buổi chiều'
            : 'Chào buổi tối';

const _weekdays = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];

/// vi-VN long date like the web hero: "Thứ Tư, 14/10/2026" (shop day).
String longShopDate([DateTime? now]) {
  final t = shopNow(now);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${_weekdays[t.weekday - 1]}, ${two(t.day)}/${two(t.month)}/${t.year}';
}

/// GET /api/zalo/status: { state: ok|warn|off|unknown, label }.
class ZaloStatus {
  const ZaloStatus({required this.state, required this.label});

  factory ZaloStatus.fromJson(Map<String, dynamic> j) {
    final state = _s(j['state']);
    return ZaloStatus(
      state: const ['ok', 'warn', 'off', 'unknown'].contains(state) ? state : 'unknown',
      label: _so(j['label']) ?? 'Zalo: không rõ',
    );
  }

  static const unknown = ZaloStatus(state: 'unknown', label: 'Zalo: không rõ');

  final String state;
  final String label;
}

class ReceiptError {
  const ReceiptError({required this.id, required this.orderCode, this.error, this.completedAt});

  factory ReceiptError.fromJson(Map<String, dynamic> j) => ReceiptError(
        id: _i(j['id']),
        orderCode: _s(j['order_code']),
        error: _so(j['receipt_error']),
        completedAt: _so(j['completed_at']),
      );

  final int id;
  final String orderCode;
  final String? error;
  final String? completedAt;
}

/// GET /api/admin/notifications
class NotificationsData {
  const NotificationsData({required this.lowStock, required this.counts, required this.receiptErrors});

  factory NotificationsData.fromJson(Map<String, dynamic> j) => NotificationsData(
        lowStock: [for (final r in _list(j['low_stock'])) LowStockItem.fromJson(r)],
        counts: QueueCounts.fromJson(_map(j['counts'])),
        receiptErrors: [for (final r in _list(j['receipt_errors'])) ReceiptError.fromJson(r)],
      );

  final List<LowStockItem> lowStock;
  final QueueCounts counts;
  final List<ReceiptError> receiptErrors;
}

enum NoteTarget { push, go }

/// One row of the bell panel: dot tone, text, optional time, and where it leads in the app.
class NoteRow {
  const NoteRow({required this.text, this.time, required this.tone, required this.location, required this.target});

  final String text;
  final String? time;
  final Tone tone;
  final String location;
  final NoteTarget target;
}

/// notifications() in common.js, same order: up to 3 failed Zalo bills, live drafts, unpaid bills,
/// up to 5 low-stock ingredients.
List<NoteRow> buildNotes(NotificationsData d, {DateTime? now}) => [
      for (final e in d.receiptErrors.take(3))
        NoteRow(
          text: 'Bill Zalo gửi lỗi — ${e.orderCode}',
          time: e.completedAt == null ? null : ago(e.completedAt, now: now),
          tone: Tone.bad,
          location: '/orders/${e.id}',
          target: NoteTarget.push,
        ),
      if (d.counts.drafts > 0)
        NoteRow(
          text: '${d.counts.drafts} đơn Zalo chờ khách xác nhận',
          tone: Tone.info,
          location: '/orders?status=draft',
          target: NoteTarget.go,
        ),
      if (d.counts.unpaid > 0)
        NoteRow(
          text: '${d.counts.unpaid} đơn chờ thu tiền',
          tone: Tone.warn,
          location: '/orders?status=completed&payment=unpaid',
          target: NoteTarget.go,
        ),
      for (final i in d.lowStock.take(5))
        NoteRow(
          text: '${i.name} dưới mức tồn tối thiểu',
          tone: Tone.warn,
          location: '/inventory/${i.id}',
          target: NoteTarget.push,
        ),
    ];
