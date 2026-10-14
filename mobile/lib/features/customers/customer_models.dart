import '../../core/format.dart';
import '../../core/widgets/common.dart';

/// Rows of the customer API (GET/POST/PUT /api/admin/customers...). Keys are the server's snake_case columns;
/// DECIMAL columns arrive as JSON numbers, dates as ISO-8601 UTC.
num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
int _i(Object? v) => _n(v).toInt();
int? _iOrNull(Object? v) => v == null ? null : int.tryParse('$v') ?? (v is num ? v.toInt() : null);
String? _s(Object? v) {
  if (v == null) return null;
  final s = '$v';
  return s.isEmpty ? null : s;
}

List<Map<String, dynamic>> _list(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const [];

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : const {};

class Customer {
  const Customer({
    required this.id,
    required this.name,
    this.phone,
    this.zaloUserId,
    this.note,
    this.createdAt,
    this.updatedAt,
    this.balance = 0,
    this.orderCount = 0,
  });

  factory Customer.fromJson(Map<String, dynamic> j) => Customer(
        id: _i(j['id']),
        name: '${j['name'] ?? ''}',
        phone: _s(j['phone']),
        zaloUserId: _s(j['zalo_user_id']),
        note: _s(j['note']),
        createdAt: _s(j['created_at']),
        updatedAt: _s(j['updated_at']),
        balance: _n(j['balance']),
        orderCount: _i(j['order_count']),
      );

  final int id;
  final String name;
  final String? phone;
  final String? zaloUserId;
  final String? note;
  final String? createdAt;
  final String? updatedAt;
  final num balance;
  final int orderCount;

  bool get hasZalo => zaloUserId != null;
  bool get owes => balance > 0;

  /// Initials of the last two words, like the web avatar ("Nguyễn Văn An" -> "VA").
  String get initials {
    final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    final last = words.length > 2 ? words.sublist(words.length - 2) : words;
    final s = last.map((w) => String.fromCharCodes(w.runes.take(1))).join().toUpperCase();
    return s.isEmpty ? '?' : s;
  }
}

class CustomerStats {
  const CustomerStats({this.totalCustomers = 0, this.debtCustomers = 0, this.totalDebt = 0});

  factory CustomerStats.fromJson(Map<String, dynamic> j) => CustomerStats(
        totalCustomers: _i(j['total_customers']),
        debtCustomers: _i(j['debt_customers']),
        totalDebt: _n(j['total_debt']),
      );

  final int totalCustomers;
  final int debtCustomers;
  final num totalDebt;
}

/// GET /api/admin/customers -> { customers, total, page, pages, page_size, stats }
class CustomerPage {
  const CustomerPage({required this.customers, required this.total, required this.page, required this.pages, required this.pageSize, required this.stats});

  factory CustomerPage.fromJson(Map<String, dynamic> j) {
    final customers = [for (final m in _list(j['customers'])) Customer.fromJson(m)];
    final size = _i(j['page_size']) > 0 ? _i(j['page_size']) : 25;
    final total = j['total'] == null ? customers.length : _i(j['total']);
    final pages = _i(j['pages']) > 0 ? _i(j['pages']) : ((total + size - 1) ~/ size).clamp(1, 1 << 30);
    final page = _i(j['page']) > 0 ? _i(j['page']) : 1;
    return CustomerPage(
      customers: customers,
      total: total,
      page: page,
      pages: pages,
      pageSize: size,
      stats: CustomerStats.fromJson(_map(j['stats'])),
    );
  }

  final List<Customer> customers;
  final int total;
  final int page;
  final int pages;
  final int pageSize;
  final CustomerStats stats;

  int get from => (page - 1) * pageSize + 1;
  int get to => total < page * pageSize ? total : page * pageSize;
}

class LedgerEntry {
  const LedgerEntry({
    required this.id,
    required this.entryType,
    required this.amount,
    this.method,
    this.note,
    this.createdAt,
    this.orderId,
    this.orderCode,
    this.createdByName,
    this.after = 0,
  });

  factory LedgerEntry.fromJson(Map<String, dynamic> j, {num after = 0}) => LedgerEntry(
        id: _i(j['id']),
        entryType: '${j['entry_type'] ?? ''}',
        amount: _n(j['amount']),
        method: _s(j['method']),
        note: _s(j['note']),
        createdAt: _s(j['created_at']),
        orderId: _iOrNull(j['order_id']),
        orderCode: _s(j['order_code']),
        createdByName: _s(j['created_by_name']),
        after: after,
      );

  final int id;
  final String entryType;

  /// Signed: > 0 increases the debt.
  final num amount;
  final String? method;
  final String? note;
  final String? createdAt;
  final int? orderId;
  final String? orderCode;
  final String? createdByName;

  /// Running balance right after this row (computed from the current balance, newest first).
  final num after;

  bool get increases => amount > 0;

  /// The web hides the auto-generated "Nợ đơn CF..." notes.
  String? get visibleNote => note != null && !note!.startsWith('Nợ đơn ') ? note : null;
}

class CustomerOrder {
  const CustomerOrder({
    required this.id,
    required this.orderCode,
    required this.status,
    required this.paymentStatus,
    required this.total,
    this.createdAt,
    this.completedAt,
    this.source,
  });

  factory CustomerOrder.fromJson(Map<String, dynamic> j) => CustomerOrder(
        id: _i(j['id']),
        orderCode: '${j['order_code'] ?? '#${j['id']}'}',
        status: '${j['status'] ?? ''}',
        paymentStatus: '${j['payment_status'] ?? ''}',
        total: _n(j['total']),
        createdAt: _s(j['created_at']),
        completedAt: _s(j['completed_at']),
        source: _s(j['source']),
      );

  final int id;
  final String orderCode;
  final String status;
  final String paymentStatus;
  final num total;
  final String? createdAt;
  final String? completedAt;
  final String? source;

  bool get unpaidDebt => status == 'completed' && paymentStatus == 'unpaid';
}

/// GET /api/admin/customers/:id -> { customer, ledger (newest first, 100), orders (50) }
class CustomerDetail {
  const CustomerDetail({required this.customer, required this.ledger, required this.orders});

  factory CustomerDetail.fromJson(Map<String, dynamic> j) {
    final customer = Customer.fromJson(_map(j['customer']));
    // Running balance like the web: start from the current balance and walk back through the rows.
    var run = customer.balance;
    final ledger = <LedgerEntry>[];
    for (final m in _list(j['ledger'])) {
      final e = LedgerEntry.fromJson(m, after: run);
      run -= e.amount;
      ledger.add(e);
    }
    return CustomerDetail(customer: customer, ledger: ledger, orders: [for (final m in _list(j['orders'])) CustomerOrder.fromJson(m)]);
  }

  final Customer customer;
  final List<LedgerEntry> ledger;
  final List<CustomerOrder> orders;

  List<CustomerOrder> get unpaid => orders.where((o) => o.unpaidDebt).toList();
  num get unpaidTotal => unpaid.fold<num>(0, (s, o) => s + o.total);

  /// 'Tổng phát sinh' and 'Đã thu' are computed from the loaded rows only, as on the web.
  num get debtTotal => ledger.where((l) => l.entryType == 'debt').fold<num>(0, (s, l) => s + l.amount);
  num get paidTotal => ledger.where((l) => l.entryType == 'payment').fold<num>(0, (s, l) => s - l.amount);
}

class ReconRow {
  const ReconRow({required this.id, required this.name, this.phone, required this.opening, required this.increase, required this.decrease, required this.closing});

  factory ReconRow.fromJson(Map<String, dynamic> j) => ReconRow(
        id: _i(j['id']),
        name: '${j['name'] ?? ''}',
        phone: _s(j['phone']),
        opening: _n(j['opening']),
        increase: _n(j['increase']),
        decrease: _n(j['decrease']),
        closing: _n(j['closing']),
      );

  final int id;
  final String name;
  final String? phone;
  final num opening;
  final num increase;
  final num decrease;
  final num closing;
}

class PeriodPreset {
  const PeriodPreset({required this.key, required this.label, required this.from, required this.to});

  factory PeriodPreset.fromJson(Map<String, dynamic> j) =>
      PeriodPreset(key: '${j['key'] ?? ''}', label: '${j['label'] ?? ''}', from: '${j['from'] ?? ''}', to: '${j['to'] ?? ''}');

  final String key;
  final String label;
  final String from;
  final String to;
}

/// GET /api/admin/customers/reconciliation -> { period: {from, to}, rows, totals, presets }
class Reconciliation {
  const Reconciliation({required this.from, required this.to, required this.rows, required this.totals, required this.presets});

  factory Reconciliation.fromJson(Map<String, dynamic> j) {
    final period = _map(j['period']);
    final rows = [for (final m in _list(j['rows'])) ReconRow.fromJson(m)];
    final t = _map(j['totals']);
    final totals = t.isEmpty
        ? ReconRow(
            id: 0,
            name: '',
            opening: rows.fold<num>(0, (s, r) => s + r.opening),
            increase: rows.fold<num>(0, (s, r) => s + r.increase),
            decrease: rows.fold<num>(0, (s, r) => s + r.decrease),
            closing: rows.fold<num>(0, (s, r) => s + r.closing),
          )
        : ReconRow.fromJson({...t, 'id': 0, 'name': ''});
    return Reconciliation(
      from: '${period['from'] ?? ''}',
      to: '${period['to'] ?? ''}',
      rows: rows,
      totals: totals,
      presets: [for (final m in _list(j['presets'])) PeriodPreset.fromJson(m)],
    );
  }

  final String from;
  final String to;
  final List<ReconRow> rows;
  final ReconRow totals;
  final List<PeriodPreset> presets;
}

/// Labels and tones copied from views/pages/customer_detail.ejs and src/utils/viewHelpers.js.
const entryLabels = <String, (String, Tone)>{
  'debt': ('Phát sinh nợ', Tone.warn),
  'payment': ('Thu nợ', Tone.good),
  'adjust': ('Điều chỉnh', Tone.info),
};

const methodLabels = <String, String>{'cash': 'Tiền mặt', 'transfer': 'Chuyển khoản', 'card': 'Thẻ', 'other': 'Khác'};

(String, Tone) orderStatusOf(String status, String paymentStatus) {
  if (status == 'completed' && paymentStatus == 'unpaid') return ('Chờ thu tiền', Tone.warn);
  return switch (status) {
    'draft' => ('Chờ khách xác nhận', Tone.warn),
    'open' => ('Đang phục vụ', Tone.info),
    'completed' => ('Hoàn tất', Tone.good),
    'cancelled' => ('Đã hủy', Tone.neutral),
    _ => (status, Tone.neutral),
  };
}

/// "2026-10-01" -> "01/10/2026" (fmtDay in debt_reconciliation.ejs).
String fmtDay(String isoDay) => isoDay.isEmpty ? '—' : isoDay.split('-').reversed.join('/');

/// Flash text of the adjust result, word for word from src/controllers/admin/customers.js adjust().
String adjustMessage(num balance, Object? notify) {
  final b = StringBuffer('Đã điều chỉnh công nợ. Số dư mới ${money(balance)}.');
  if (notify is Map) {
    switch (notify['customer']) {
      case 'sent':
        b.write(' Đã gửi Zalo cho khách.');
      case 'not_linked':
        b.write(' Khách chưa liên kết Zalo nên chưa nhận được tin.');
      case 'failed':
        b.write(' Gửi Zalo cho khách không thành công.');
      case 'push_not_supported':
        b.write(' Chế độ Zalo hiện tại không hỗ trợ gửi tin chủ động cho khách.');
    }
    switch (notify['owner']) {
      case 'sent':
        b.write(' Đã báo chủ quán qua Zalo.');
      case 'not_configured':
        b.write(' Chưa cấu hình Chat ID Zalo nhận công nợ của chủ quán.');
      case 'failed':
        b.write(' Gửi Zalo cho chủ quán không thành công.');
      case 'push_not_supported':
        b.write(' Chế độ Zalo hiện tại không hỗ trợ gửi tin chủ động cho chủ quán.');
    }
  }
  return b.toString();
}

num parseNum(Object? v) => _n(v);
List<String> parseStrings(Object? v) => v is List ? [for (final e in v) '$e'] : const [];
