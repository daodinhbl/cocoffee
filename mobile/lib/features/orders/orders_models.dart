import '../../core/widgets/common.dart';

/// Rows and labels for the Orders module, read from the snake_case JSON of GET /api/orders and
/// GET /api/orders/:id?include=payments. Labels are the Web Admin ones (src/utils/viewHelpers.js).

num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
num? _nn(Object? v) => v == null ? null : (v is num ? v : num.tryParse('$v'));
int _i(Object? v) => _n(v).toInt();
int? _ii(Object? v) => _nn(v)?.toInt();
String? _s(Object? v) {
  if (v == null) return null;
  final s = '$v';
  return s.isEmpty ? null : s;
}

List<Map<String, dynamic>> _list(Object? v) =>
    v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : const [];

/// ORDER_STATUS in viewHelpers.js: status -> [label, tone].
const _orderStatus = <String, (String, Tone)>{
  'draft': ('Chờ khách xác nhận', Tone.warn),
  'open': ('Đang phục vụ', Tone.info),
  'completed': ('Hoàn tất', Tone.good),
  'cancelled': ('Đã hủy', Tone.neutral),
};

/// orderStatusBadge(o): a completed order whose money is not collected reads "Chờ thu tiền".
(String, Tone) orderStatusLabel(String status, String? paymentStatus) {
  if (status == 'completed' && paymentStatus == 'unpaid') return ('Chờ thu tiền', Tone.warn);
  return _orderStatus[status] ?? (status, Tone.neutral);
}

/// sourceBadge(source)
(String, Tone) sourceLabel(String? source) => source == 'zalo' ? ('Zalo', Tone.info) : ('POS', Tone.neutral);

/// METHOD_LABEL
const methodLabels = <String, String>{
  'cash': 'Tiền mặt',
  'transfer': 'Chuyển khoản',
  'card': 'Thẻ',
  'other': 'Khác',
  'unpaid': 'Chưa thu',
};

String methodLabel(String? m) => methodLabels[m] ?? (m ?? '—');

/// marginTone(margin): >= 65 good, >= 55 warn, else bad.
Tone marginTone(num margin) => margin >= 65 ? Tone.good : (margin >= 55 ? Tone.warn : Tone.bad);

/// One row of GET /api/orders.
class OrderRow {
  const OrderRow({
    required this.id,
    required this.orderCode,
    required this.source,
    required this.status,
    this.paymentStatus,
    this.paymentMethod,
    required this.total,
    this.tableCode,
    this.customerId,
    this.customerName,
    required this.itemCount,
    this.createdAt,
    this.receiptError,
  });

  factory OrderRow.fromJson(Map<String, dynamic> j) => OrderRow(
        id: _i(j['id']),
        orderCode: _s(j['order_code']) ?? '#${j['id']}',
        source: _s(j['source']) ?? 'pos',
        status: _s(j['status']) ?? '',
        paymentStatus: _s(j['payment_status']),
        paymentMethod: _s(j['payment_method']),
        total: _n(j['total']),
        tableCode: _s(j['table_code']),
        customerId: _ii(j['customer_id']),
        customerName: _s(j['customer_name']),
        itemCount: _n(j['item_count']),
        createdAt: _s(j['created_at']),
        receiptError: _s(j['receipt_error']),
      );

  final int id;
  final String orderCode;
  final String source;
  final String status;
  final String? paymentStatus;
  final String? paymentMethod;
  final num total;
  final String? tableCode;
  final int? customerId;
  final String? customerName;
  final num itemCount;
  final String? createdAt;
  final String? receiptError;

  /// "Bàn / Khách" cell: customer, else table, else Zalo guest / takeaway.
  String get who => customerName ?? (tableCode != null ? 'Bàn $tableCode' : (source == 'zalo' ? 'Khách Zalo' : 'Mang đi'));

  /// The web offers "In hóa đơn" only for open and completed orders.
  bool get printable => status == 'open' || status == 'completed';
}

/// counts = orderModel.breakdown(where); unpaidAmount and openAmount are camelCase in the contract.
class OrderCounts {
  const OrderCounts({
    this.all = 0,
    this.draft = 0,
    this.open = 0,
    this.completed = 0,
    this.cancelled = 0,
    this.unpaid = 0,
    this.revenue = 0,
    this.unpaidAmount = 0,
    this.openAmount = 0,
  });

  factory OrderCounts.fromJson(Map<String, dynamic> j) => OrderCounts(
        all: _i(j['all']),
        draft: _i(j['draft']),
        open: _i(j['open']),
        completed: _i(j['completed']),
        cancelled: _i(j['cancelled']),
        unpaid: _i(j['unpaid']),
        revenue: _n(j['revenue']),
        unpaidAmount: _n(j['unpaidAmount'] ?? j['unpaid_amount']),
        openAmount: _n(j['openAmount'] ?? j['open_amount']),
      );

  final int all, draft, open, completed, cancelled, unpaid;
  final num revenue, unpaidAmount, openAmount;
}

/// GET /api/orders -> { orders, total, page, pages, page_size, counts }
class OrdersPage {
  const OrdersPage({required this.orders, required this.total, required this.page, required this.pages, required this.pageSize, this.counts});

  factory OrdersPage.fromJson(Map<String, dynamic> j) {
    final orders = [for (final o in _list(j['orders'])) OrderRow.fromJson(o)];
    final pageSize = _ii(j['page_size']) ?? 25;
    final total = _ii(j['total']) ?? orders.length;
    final pages = _ii(j['pages']) ?? (total == 0 ? 1 : ((total + pageSize - 1) ~/ pageSize));
    final counts = j['counts'];
    return OrdersPage(
      orders: orders,
      total: total,
      page: _ii(j['page']) ?? 1,
      pages: pages < 1 ? 1 : pages,
      pageSize: pageSize,
      counts: counts is Map ? OrderCounts.fromJson(Map<String, dynamic>.from(counts)) : null,
    );
  }

  final List<OrderRow> orders;
  final int total;
  final int page;
  final int pages;
  final int pageSize;

  /// Null when the server does not send the breakdown (summary cards and tab counts are then hidden).
  final OrderCounts? counts;

  int get firstIndex => total == 0 ? 0 : (page - 1) * pageSize + 1;
  int get lastIndex => total == 0 ? 0 : (firstIndex + orders.length - 1);
}

class OrderItem {
  const OrderItem({required this.id, required this.productName, required this.unitPrice, required this.quantity, required this.lineTotal, this.note});

  factory OrderItem.fromJson(Map<String, dynamic> j) => OrderItem(
        id: _i(j['id']),
        productName: _s(j['product_name']) ?? '—',
        unitPrice: _n(j['unit_price']),
        quantity: _n(j['quantity']),
        lineTotal: _n(j['line_total']),
        note: _s(j['note']),
      );

  final int id;
  final String productName;
  final num unitPrice;
  final num quantity;
  final num lineTotal;

  /// Item note; drink options chosen in the Zalo chatbot are stored here too.
  final String? note;
}

class OrderPayment {
  const OrderPayment({required this.id, required this.method, required this.amount, this.reference, this.paidAt, this.receivedByName});

  factory OrderPayment.fromJson(Map<String, dynamic> j) => OrderPayment(
        id: _i(j['id']),
        method: _s(j['method']) ?? '',
        amount: _n(j['amount']),
        reference: _s(j['reference']),
        paidAt: _s(j['paid_at']),
        receivedByName: _s(j['received_by_name']),
      );

  final int id;
  final String method;
  final num amount;
  final String? reference;
  final String? paidAt;
  final String? receivedByName;
}

/// GET /api/orders/:id?include=payments -> { order: OrderWithItems, payments: [...] }
class OrderDetail {
  const OrderDetail({
    required this.id,
    required this.orderCode,
    required this.status,
    this.paymentStatus,
    this.paymentMethod,
    required this.source,
    required this.subtotal,
    required this.discount,
    required this.total,
    this.cogsTotal,
    this.note,
    this.customerId,
    this.customerName,
    this.tableName,
    this.tableCode,
    this.zaloChatType,
    this.zaloUserId,
    this.createdAt,
    this.completedAt,
    this.paidAt,
    this.receiptSentAt,
    this.receiptError,
    this.items = const [],
    this.payments = const [],
  });

  factory OrderDetail.fromJson(Map<String, dynamic> res) {
    final o = res['order'] is Map ? Map<String, dynamic>.from(res['order'] as Map) : res;
    return OrderDetail(
      id: _i(o['id']),
      orderCode: _s(o['order_code']) ?? '#${o['id']}',
      status: _s(o['status']) ?? '',
      paymentStatus: _s(o['payment_status']),
      paymentMethod: _s(o['payment_method']),
      source: _s(o['source']) ?? 'pos',
      subtotal: _n(o['subtotal']),
      discount: _n(o['discount']),
      total: _n(o['total']),
      cogsTotal: _nn(o['cogs_total']),
      note: _s(o['note']),
      customerId: _ii(o['customer_id']),
      customerName: _s(o['customer_name']),
      tableName: _s(o['table_name']),
      tableCode: _s(o['table_code']),
      zaloChatType: _s(o['zalo_chat_type']),
      zaloUserId: _s(o['zalo_user_id']),
      createdAt: _s(o['created_at']),
      completedAt: _s(o['completed_at']),
      paidAt: _s(o['paid_at']),
      receiptSentAt: _s(o['receipt_sent_at']),
      receiptError: _s(o['receipt_error']),
      items: [for (final i in _list(o['items'])) OrderItem.fromJson(i)],
      payments: [for (final p in _list(res['payments'] ?? o['payments'])) OrderPayment.fromJson(p)],
    );
  }

  final int id;
  final String orderCode;
  final String status;
  final String? paymentStatus;
  final String? paymentMethod;
  final String source;
  final num subtotal;
  final num discount;
  final num total;

  /// Null when the server strips cost data (cashier accounts).
  final num? cogsTotal;
  final String? note;
  final int? customerId;
  final String? customerName;
  final String? tableName;
  final String? tableCode;
  final String? zaloChatType;
  final String? zaloUserId;
  final String? createdAt;
  final String? completedAt;
  final String? paidAt;
  final String? receiptSentAt;
  final String? receiptError;
  final List<OrderItem> items;
  final List<OrderPayment> payments;

  bool get isPaid => paymentStatus == 'paid';
  bool get isOpen => status == 'open';
  bool get isComplete => status == 'completed';
  bool get canCancel => status == 'draft' || status == 'open';
  bool get canPay => status == 'open' || (status == 'completed' && paymentStatus == 'unpaid');
  bool get canResend => source == 'zalo' && status == 'completed';

  /// "Ghi công nợ" (admin): a delivered, unpaid Zalo order that is not on any customer's ledger.
  bool get canRecordDebt => source == 'zalo' && status == 'completed' && paymentStatus == 'unpaid' && customerId == null;
  bool get printable => status == 'open' || status == 'completed';
  num get profit => total - (cogsTotal ?? 0);
  num get margin => total > 0 ? profit / total * 100 : 0;
}
