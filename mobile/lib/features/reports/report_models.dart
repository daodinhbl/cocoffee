import 'dart:math' as math;

import '../../core/format.dart';

/// Data of GET /api/admin/reports (the Web Admin's views/pages/reports.ejs, src/controllers/admin/reports.js).
/// Numbers may arrive as MySQL DECIMAL strings ("125000.00"), so every field is parsed leniently.

num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
double _d(Object? v) => _n(v).toDouble();
int _i(Object? v) => _n(v).round();

List<Map<String, dynamic>> _rows(Object? v) =>
    v is List ? [for (final r in v) if (r is Map) Map<String, dynamic>.from(r)] : const [];

String _two(int n) => n.toString().padLeft(2, '0');

/// Same labels as the web (SOURCE in reports.ejs, METHOD_LABEL in src/utils/viewHelpers.js).
const kSourceLabel = {'pos': 'POS', 'zalo': 'Zalo'};
const kMethodLabel = {'cash': 'Tiền mặt', 'transfer': 'Chuyển khoản', 'card': 'Thẻ', 'other': 'Khác', 'unpaid': 'Chưa thu'};

/// "YYYY-MM-DD" -> local calendar date (no time-zone shift). Null when it is not a day.
DateTime? parseDayKey(String? s) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(s ?? '');
  if (m == null) return null;
  final d = DateTime(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
  return d.month == int.parse(m[2]!) ? d : null;
}

/// Normalises a day value from the API to "YYYY-MM-DD": plain days stay as they are, timestamps become the shop day (UTC+7).
String normalizeDay(Object? v) {
  final s = '${v ?? ''}';
  if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(s)) return s;
  final t = DateTime.tryParse(s);
  if (t == null) return s.length >= 10 ? s.substring(0, 10) : s;
  if (!t.isUtc) return isoDay(t); // no zone in the text: already a shop-local timestamp
  return isoDay(t.toUtc().add(const Duration(hours: 7)));
}

/// "YYYY-MM-DD" plus [days] (calendar arithmetic, safe across DST because it uses noon UTC).
String addDays(String day, int days) {
  final d = parseDayKey(day);
  if (d == null) return day;
  final t = DateTime.utc(d.year, d.month, d.day, 12).add(Duration(days: days));
  return '${t.year}-${_two(t.month)}-${_two(t.day)}';
}

/// Today in the shop's zone (UTC+7), whatever the phone's zone.
String shopToday([DateTime? now]) {
  final t = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 7));
  return '${t.year}-${_two(t.month)}-${_two(t.day)}';
}

/// "2026-10-14" -> "14/10" (dayLabel in reports.ejs).
String dayLabel(String day) => day.length >= 10 ? '${day.substring(8, 10)}/${day.substring(5, 7)}' : day;

/// "2026-10-14" -> "14/10/2026".
String dayFull(String day) => day.length >= 10 ? '${dayLabel(day)}/${day.substring(0, 4)}' : day;

/// rangeText in reports.ejs: one day, or "dd/MM/yyyy – dd/MM/yyyy".
String rangeText(String from, String to) => from == to ? dayFull(from) : '${dayFull(from)} – ${dayFull(to)}';

/// share() in reports.ejs: percentage of the total revenue, '—' when there is no revenue.
String share(double value, double total) => total > 0 ? pct(value / total * 100) : '—';

class ReportPreset {
  const ReportPreset({required this.key, required this.label, required this.from, required this.to});

  factory ReportPreset.fromJson(Map<String, dynamic> j) => ReportPreset(
        key: '${j['key'] ?? ''}',
        label: '${j['label'] ?? ''}',
        from: normalizeDay(j['from']),
        to: normalizeDay(j['to']),
      );

  final String key, label, from, to;
}

/// presets() in src/controllers/admin/reports.js; used only when the API leaves `presets` out.
List<ReportPreset> defaultPresets(String today) {
  final monthStart = '${today.substring(0, 7)}-01';
  final lastMonthEnd = addDays(monthStart, -1);
  return [
    ReportPreset(key: 'today', label: 'Hôm nay', from: today, to: today),
    ReportPreset(key: 'yesterday', label: 'Hôm qua', from: addDays(today, -1), to: addDays(today, -1)),
    ReportPreset(key: '7d', label: '7 ngày', from: addDays(today, -6), to: today),
    ReportPreset(key: 'month', label: 'Tháng này', from: monthStart, to: today),
    ReportPreset(key: 'last_month', label: 'Tháng trước', from: '${lastMonthEnd.substring(0, 7)}-01', to: lastMonthEnd),
  ];
}

class ReportSummary {
  const ReportSummary({required this.orders, required this.revenue, required this.cogs, required this.grossProfit, required this.unpaid});

  factory ReportSummary.fromJson(Map<String, dynamic> j) {
    final revenue = _d(j['revenue']);
    final cogs = _d(j['cogs']);
    return ReportSummary(
      orders: _i(j['orders']),
      revenue: revenue,
      cogs: cogs,
      grossProfit: j['gross_profit'] == null ? revenue - cogs : _d(j['gross_profit']),
      unpaid: _d(j['unpaid']),
    );
  }

  final int orders;
  final double revenue, cogs, grossProfit, unpaid;
}

class DaySales {
  const DaySales({required this.day, required this.orders, required this.revenue, required this.cogs});

  factory DaySales.fromJson(Map<String, dynamic> j) =>
      DaySales(day: normalizeDay(j['day']), orders: _i(j['orders']), revenue: _d(j['revenue']), cogs: _d(j['cogs']));

  final String day;
  final int orders;
  final double revenue, cogs;
  double get profit => revenue - cogs;
}

class HourSales {
  const HourSales({required this.hour, required this.orders, required this.revenue});

  factory HourSales.fromJson(Map<String, dynamic> j) => HourSales(hour: _i(j['hour']), orders: _i(j['orders']), revenue: _d(j['revenue']));

  final int hour, orders;
  final double revenue;
}

class SourceSales {
  const SourceSales({required this.source, required this.orders, required this.revenue, required this.cogs});

  factory SourceSales.fromJson(Map<String, dynamic> j) =>
      SourceSales(source: '${j['source'] ?? ''}', orders: _i(j['orders']), revenue: _d(j['revenue']), cogs: _d(j['cogs']));

  final String source;
  final int orders;
  final double revenue, cogs;
  String get label => kSourceLabel[source] ?? source;
}

class PaymentSales {
  const PaymentSales({required this.method, required this.orders, required this.revenue});

  factory PaymentSales.fromJson(Map<String, dynamic> j) =>
      PaymentSales(method: '${j['method'] ?? ''}', orders: _i(j['orders']), revenue: _d(j['revenue']));

  final String method;
  final int orders;
  final double revenue;
  String get label => kMethodLabel[method] ?? method;
}

class TopProduct {
  const TopProduct({required this.productId, required this.name, required this.qty, required this.revenue, required this.cogs});

  factory TopProduct.fromJson(Map<String, dynamic> j) => TopProduct(
        productId: _i(j['product_id']),
        name: '${j['product_name'] ?? ''}',
        qty: _d(j['qty']),
        revenue: _d(j['revenue']),
        cogs: _d(j['cogs']),
      );

  final int productId;
  final String name;
  final double qty, revenue, cogs;
  double get profit => revenue - cogs;
}

class ReportData {
  const ReportData({
    required this.from,
    required this.to,
    required this.clamped,
    required this.presets,
    required this.summary,
    required this.avgTicket,
    required this.days,
    required this.hours,
    required this.bySource,
    required this.byPayment,
    required this.top,
  });

  /// Parses the API answer. Days and hours are gap-filled again (as reports.js does) so a sparse answer still
  /// shows every day of the range and all 24 hours.
  factory ReportData.fromJson(Map<String, dynamic> j, {String? today}) {
    final range = j['range'] is Map ? Map<String, dynamic>.from(j['range'] as Map) : const <String, dynamic>{};
    final summary = ReportSummary.fromJson(j['summary'] is Map ? Map<String, dynamic>.from(j['summary'] as Map) : const {});
    final rawDays = [for (final r in _rows(j['days'])) DaySales.fromJson(r)];
    final todayKey = today ?? shopToday();

    var from = normalizeDay(range['from']);
    var to = normalizeDay(range['to']);
    if (parseDayKey(from) == null || parseDayKey(to) == null) {
      from = rawDays.isNotEmpty ? rawDays.first.day : addDays(todayKey, -6);
      to = rawDays.isNotEmpty ? rawDays.last.day : todayKey;
    }

    final dayMap = {for (final d in rawDays) d.day: d};
    final days = <DaySales>[];
    for (var d = from; d.compareTo(to) <= 0 && days.length < 400; d = addDays(d, 1)) {
      days.add(dayMap[d] ?? DaySales(day: d, orders: 0, revenue: 0, cogs: 0));
    }

    final hourMap = {for (final r in _rows(j['hours'])) _i(r['hour']): HourSales.fromJson(r)};
    final hours = [for (var h = 0; h < 24; h++) hourMap[h] ?? HourSales(hour: h, orders: 0, revenue: 0)];

    final presets = [for (final r in _rows(j['presets'])) ReportPreset.fromJson(r)];

    return ReportData(
      from: from,
      to: to,
      clamped: range['clamped'] == true || j['clamped'] == true,
      presets: presets.isNotEmpty ? presets : defaultPresets(todayKey),
      summary: summary,
      avgTicket: j['avg_ticket'] != null ? _d(j['avg_ticket']) : (summary.orders > 0 ? summary.revenue / summary.orders : 0),
      days: days,
      hours: hours,
      bySource: [for (final r in _rows(j['by_source'])) SourceSales.fromJson(r)],
      byPayment: [for (final r in _rows(j['by_payment'])) PaymentSales.fromJson(r)],
      top: [for (final r in _rows(j['top_products'])) TopProduct.fromJson(r)],
    );
  }

  final String from, to;
  final bool clamped;
  final List<ReportPreset> presets;
  final ReportSummary summary;
  final double avgTicket;
  final List<DaySales> days;
  final List<HourSales> hours;
  final List<SourceSales> bySource;
  final List<PaymentSales> byPayment;
  final List<TopProduct> top;

  /// Gross margin in percent, computed exactly like reports.js (`margin` local of the web page).
  double get margin => summary.revenue > 0 ? summary.grossProfit / summary.revenue * 100 : 0;

  bool isActive(ReportPreset p) => p.from == from && p.to == to;
}

/// Round axis ticks from 0 to a "nice" maximum at or above [maxValue] (steps of 1, 2, 2.5 or 5 x 10^n).
/// Only `[0]` when there is nothing to plot.
List<double> niceTicks(double maxValue, {int count = 4}) {
  if (!(maxValue > 0) || maxValue.isInfinite) return const [0];
  final raw = maxValue / count;
  final mag = math.pow(10, (math.log(raw) / math.ln10).floor()).toDouble();
  final r = raw / mag;
  final step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
  final n = (maxValue / step - 1e-9).ceil();
  return [for (var i = 0; i <= n; i++) i * step];
}

/// Short money for chart axes: 0, 750, 25k, 1,5tr, 2 tỷ (Vietnamese "nghìn / triệu / tỷ" shorthand).
String compactMoney(double v) {
  final a = v.abs();
  String trim(double x) => x.toStringAsFixed(2).replaceFirst(RegExp(r'\.?0+$'), '').replaceAll('.', ',');
  final sign = v < 0 ? '−' : '';
  if (a == 0) return '0';
  if (a >= 1e9) return '$sign${trim(a / 1e9)} tỷ';
  if (a >= 1e6) return '$sign${trim(a / 1e6)}tr';
  if (a >= 1e3) return '$sign${trim(a / 1e3)}k';
  return '$sign${trim(a)}';
}
