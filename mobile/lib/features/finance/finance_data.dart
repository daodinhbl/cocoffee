import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';

num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
Map<String, dynamic> _m(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
List<Map<String, dynamic>> _l(Object? v) => v is List ? [for (final e in v) _m(e)] : const [];

/// Retries only network failures (same policy as the report screen).
Duration? _retry(int count, Object error) {
  final e = error is ApiException ? error : null;
  if (e == null || count >= 3) return null;
  return e.isOffline || e.code == 'TIMEOUT' ? Duration(seconds: 1 << count) : null;
}

// ------------------------------------------------------------------ expense book
@immutable
class ExpenseCategory {
  const ExpenseCategory({required this.id, required this.name, required this.treatment});
  factory ExpenseCategory.fromJson(Map<String, dynamic> j) =>
      ExpenseCategory(id: _n(j['id']).toInt(), name: '${j['name'] ?? ''}', treatment: '${j['tax_treatment'] ?? ''}');
  final int id;
  final String name;
  final String treatment;
}

@immutable
class Expense {
  const Expense({
    required this.id, required this.date, required this.categoryId, required this.category, required this.amount,
    required this.vatIncluded, required this.payee, required this.docNo, required this.note, required this.source,
    required this.status, required this.voidReason, required this.hasReceipt, required this.purchaseCode,
  });
  factory Expense.fromJson(Map<String, dynamic> j) => Expense(
        id: _n(j['id']).toInt(),
        date: '${j['date'] ?? ''}',
        categoryId: _n(j['category_id']).toInt(),
        category: '${j['category'] ?? ''}',
        amount: _n(j['amount']),
        vatIncluded: j['vat_included'] == true,
        payee: '${j['payee'] ?? ''}',
        docNo: '${j['doc_no'] ?? ''}',
        note: '${j['note'] ?? ''}',
        source: '${j['source'] ?? 'manual'}',
        status: '${j['status'] ?? 'posted'}',
        voidReason: j['void_reason'] as String?,
        hasReceipt: j['has_receipt'] == true,
        purchaseCode: j['purchase_receipt_code'] as String?,
      );
  final int id, categoryId;
  final String date, category, payee, docNo, note, source, status;
  final num amount;
  final bool vatIncluded, hasReceipt;
  final String? voidReason, purchaseCode;

  bool get isVoid => status == 'void';
  bool get fromPurchase => source == 'purchase';
}

@immutable
class ExpenseFilter {
  const ExpenseFilter({this.from, this.to, this.categoryId, this.source, this.q = '', this.showVoid = false});
  final String? from, to, source;
  final int? categoryId;
  final String q;
  final bool showVoid;

  ExpenseFilter copyWith({String? from, String? to, int? categoryId, String? source, String? q, bool? showVoid, bool clearRange = false, bool clearCat = false, bool clearSource = false}) =>
      ExpenseFilter(
        from: clearRange ? null : (from ?? this.from),
        to: clearRange ? null : (to ?? this.to),
        categoryId: clearCat ? null : (categoryId ?? this.categoryId),
        source: clearSource ? null : (source ?? this.source),
        q: q ?? this.q,
        showVoid: showVoid ?? this.showVoid,
      );

  Map<String, dynamic> toQuery() => {
        'from': from, 'to': to, 'cat': categoryId, 'src': source, 'q': q.trim(), 'void': showVoid ? '1' : null,
      };

  @override
  bool operator ==(Object other) =>
      other is ExpenseFilter && other.from == from && other.to == to && other.categoryId == categoryId && other.source == source && other.q == q && other.showVoid == showVoid;
  @override
  int get hashCode => Object.hash(from, to, categoryId, source, q, showVoid);
}

class ExpenseFilterNotifier extends Notifier<ExpenseFilter> {
  @override
  ExpenseFilter build() => const ExpenseFilter();
  void set(ExpenseFilter f) => state = f;
}

final expenseFilterProvider = NotifierProvider.autoDispose<ExpenseFilterNotifier, ExpenseFilter>(ExpenseFilterNotifier.new);

@immutable
class ExpenseTotals {
  const ExpenseTotals({this.count = 0, this.amount = 0, this.purchases = 0, this.manual = 0, this.deductible = 0});
  factory ExpenseTotals.fromJson(Map<String, dynamic> j) => ExpenseTotals(
      count: _n(j['count']).toInt(), amount: _n(j['amount']), purchases: _n(j['purchases']), manual: _n(j['manual']), deductible: _n(j['deductible']));
  final int count;
  final num amount, purchases, manual, deductible;
}

@immutable
class ExpensePage {
  const ExpensePage({this.items = const [], this.nextBeforeId, this.totals = const ExpenseTotals()});
  final List<Expense> items;
  final int? nextBeforeId;
  final ExpenseTotals totals;
}

/// Newest-first list with keyset paging: [loadMore] appends the next page.
class ExpenseListNotifier extends AsyncNotifier<ExpensePage> {
  static const pageSize = 30;
  bool _loadingMore = false;

  @override
  Future<ExpensePage> build() => _fetch(null, const []);

  Future<ExpensePage> _fetch(int? before, List<Expense> prior) async {
    final f = ref.read(expenseFilterProvider);
    final res = await ref.read(apiProvider).get('/expenses', query: {...f.toQuery(), 'before_id': before, 'limit': pageSize});
    final items = [...prior, for (final e in _l(res['items'])) Expense.fromJson(e)];
    return ExpensePage(items: items, nextBeforeId: _n(res['next_before_id']).toInt() == 0 ? null : _n(res['next_before_id']).toInt(), totals: ExpenseTotals.fromJson(_m(res['totals'])));
  }

  Future<void> loadMore() async {
    final cur = state.value;
    if (cur == null || cur.nextBeforeId == null || _loadingMore) return;
    _loadingMore = true;
    try {
      final next = await _fetch(cur.nextBeforeId, cur.items);
      state = AsyncData(next);
    } catch (_) {
      // keep the page we have; the user can scroll again to retry
    } finally {
      _loadingMore = false;
    }
  }

  Future<void> reload() async {
    state = await AsyncValue.guard(() => _fetch(null, const []));
  }
}

final expenseListProvider = AsyncNotifierProvider.autoDispose<ExpenseListNotifier, ExpensePage>(() => ExpenseListNotifier(), retry: _retry);

final expenseCategoriesProvider = FutureProvider.autoDispose<List<ExpenseCategory>>((ref) async {
  final res = await ref.watch(apiProvider).get('/expense-categories');
  return [for (final c in _l(res['categories'])) ExpenseCategory.fromJson(c)];
}, retry: _retry);

/// What the add/edit form sends. [imageData] is a JPEG data URL; [removeImage] drops the stored photo.
class ExpenseInput {
  const ExpenseInput({required this.date, required this.categoryId, required this.amount, this.vatIncluded = false, this.payee = '', this.docNo = '', this.note = '', this.imageData, this.removeImage = false});
  final String date, payee, docNo, note;
  final int categoryId;
  final num amount;
  final bool vatIncluded, removeImage;
  final String? imageData;

  Map<String, dynamic> toJson({bool update = false}) => {
        'expense_date': date, 'category_id': categoryId, 'amount': amount, 'vat_included': vatIncluded,
        'payee': payee, 'doc_no': docNo, 'note': note,
        if (imageData != null) 'image_data': imageData,
        if (update && removeImage) 'remove_image': true,
      };
}

/// Writes of the expense book and the tax screens (online only: the books are an accounting record, so a write is
/// never queued blindly). Each create carries an Idempotency-Key chosen once per form so a retry cannot double-book.
class FinanceActions {
  FinanceActions(this._ref);
  final Ref _ref;
  ApiClient get _api => _ref.read(apiProvider);

  void _refresh() {
    _ref.invalidate(expenseListProvider);
    _ref.invalidate(financeDashboardProvider);
  }

  Future<Expense> create(ExpenseInput i, String idempotencyKey) async {
    final res = await _api.post('/expenses', i.toJson(), {'Idempotency-Key': idempotencyKey});
    _refresh();
    return Expense.fromJson(_m(res['expense']));
  }

  Future<Expense> update(int id, ExpenseInput i) async {
    final res = await _api.put('/expenses/$id', i.toJson(update: true));
    _refresh();
    return Expense.fromJson(_m(res['expense']));
  }

  Future<void> voidExpense(int id, String reason) async {
    await _api.post('/expenses/$id/void', {'reason': reason});
    _refresh();
  }

  Future<void> period(String action, String kind, String date, {String? ref}) async {
    await _api.post('/tax/periods/$action', {'kind': kind, 'date': date, 'ref': ?ref});
    _ref.invalidate(financeDashboardProvider);
    _ref.invalidate(expenseListProvider);
  }

  Future<TaxExport> createExport(String kind, String from, String to) async {
    final res = await _api.post('/tax/exports', {'kind': kind, 'from': from, 'to': to});
    _ref.invalidate(taxExportsProvider);
    return TaxExport.fromJson(_m(res['export']));
  }

  /// The receipt photo (needs the bearer token, so it is fetched through the client).
  Future<Uint8List?> receiptBytes(int id) => _api.bytes('/expenses/$id/receipt');

  /// Downloads the finished book to the temp folder and returns the file.
  Future<File> downloadExport(TaxExport e) async {
    final bytes = await _api.bytes('/tax/exports/${e.id}/file');
    if (bytes == null) throw ApiException(code: 'NOT_FOUND', message: 'File chưa sẵn sàng hoặc đã hết hạn lưu (7 ngày).');
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}${Platform.pathSeparator}${e.fileName ?? 'so-thue-${e.id}.xlsx'}');
    return file.writeAsBytes(bytes, flush: true);
  }
}

final financeActionsProvider = Provider<FinanceActions>(FinanceActions.new);

// ------------------------------------------------------------------ tax dashboard
@immutable
class PeriodRef {
  const PeriodRef({required this.kind, required this.from, required this.to, required this.label});
  factory PeriodRef.fromJson(Map<String, dynamic> j) =>
      PeriodRef(kind: '${j['kind']}', from: '${j['from']}', to: '${j['to']}', label: '${j['label'] ?? ''}');
  final String kind, from, to, label;
}

@immutable
class FinanceDashboard {
  const FinanceDashboard({required this.json});
  final Map<String, dynamic> json;

  PeriodRef get period => PeriodRef.fromJson(_m(json['period']));
  PeriodRef get prev => PeriodRef.fromJson(_m(json['prev']));
  PeriodRef get next => PeriodRef.fromJson(_m(json['next']));
  Map<String, dynamic> get estimate => _m(json['estimate']);
  Map<String, dynamic> get revenue => _m(estimate['revenue']);
  Map<String, dynamic> get expenses => _m(estimate['expenses']);
  Map<String, dynamic> get year => _m(estimate['year']);
  Map<String, dynamic> get config => _m(estimate['config']);
  List<Map<String, dynamic>> get categories => _l(estimate['categories']);
  List<Map<String, dynamic>> get months => _l(json['months']);
  num get profit => _n(estimate['profit']);
  num get vat => _n(estimate['vat']);
  num get pit => _n(estimate['pit']);
  num get tax => _n(estimate['tax']);
  num get taxableRevenue => _n(estimate['taxable_revenue']);

  /// null (open) / 'locked' / 'filed'.
  String? get lockStatus => json['lock'] is Map ? '${(json['lock'] as Map)['status']}' : null;
  String? get filedRef => json['lock'] is Map ? (json['lock'] as Map)['filed_ref'] as String? : null;
}

@immutable
class FinanceQuery {
  const FinanceQuery(this.kind, this.date);
  final String kind; // month | quarter | year
  final String? date; // any day inside the wanted period; null = now
  @override
  bool operator ==(Object other) => other is FinanceQuery && other.kind == kind && other.date == date;
  @override
  int get hashCode => Object.hash(kind, date);
}

class FinanceQueryNotifier extends Notifier<FinanceQuery> {
  @override
  FinanceQuery build() => const FinanceQuery('month', null);
  void set(FinanceQuery q) => state = q;
}

final financeQueryProvider = NotifierProvider.autoDispose<FinanceQueryNotifier, FinanceQuery>(FinanceQueryNotifier.new);

final financeDashboardProvider = FutureProvider.autoDispose<FinanceDashboard>((ref) async {
  final q = ref.watch(financeQueryProvider);
  final res = await ref.watch(apiProvider).get('/finance/dashboard', query: {'kind': q.kind, 'date': q.date});
  return FinanceDashboard(json: res);
}, retry: _retry);

// ------------------------------------------------------------------ exports
@immutable
class TaxExport {
  const TaxExport({required this.id, required this.kind, required this.from, required this.to, required this.status, this.fileName, this.fileBytes, this.error, required this.downloadable});
  factory TaxExport.fromJson(Map<String, dynamic> j) => TaxExport(
        id: _n(j['id']).toInt(), kind: '${j['kind']}', from: '${j['from']}', to: '${j['to']}', status: '${j['status']}',
        fileName: j['file_name'] as String?, fileBytes: j['file_bytes'] == null ? null : _n(j['file_bytes']).toInt(),
        error: j['error'] as String?, downloadable: j['downloadable'] == true,
      );
  final int id;
  final String kind, from, to, status;
  final String? fileName, error;
  final int? fileBytes;
  final bool downloadable;

  bool get running => status == 'queued' || status == 'running';
  bool get failed => status == 'failed';
}

const taxExportKinds = <String, String>{
  'revenue_book': 'Sổ doanh thu',
  'expense_book': 'Sổ chi phí',
  'declaration': 'Bảng kê tờ khai',
  'bundle': 'Gói đủ 3 sổ',
};

/// The last 20 exports; polls every 3 s while any is still queued or running.
final taxExportsProvider = FutureProvider.autoDispose<List<TaxExport>>((ref) async {
  final res = await ref.watch(apiProvider).get('/tax/exports', useCache: false);
  final list = [for (final e in _l(res['exports'])) TaxExport.fromJson(e)];
  if (list.any((e) => e.running)) {
    final t = Timer(const Duration(seconds: 3), ref.invalidateSelf);
    ref.onDispose(t.cancel);
  }
  return list;
}, retry: _retry);
