import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import 'customer_models.dart';

/// Reads show their error with a "Thử lại" button instead of retrying on their own (a 404 stays a 404).
Duration? _noRetry(int _, Object _) => null;

/// Filters of the customers list, the same query string as the web: ?q=&debt=1&zalo=1&page=
class CustomersFilter {
  const CustomersFilter({this.q = '', this.debt = false, this.zalo = false, this.page = 1});

  final String q;
  final bool debt;
  final bool zalo;
  final int page;

  bool get hasFilter => q.isNotEmpty || debt || zalo;

  Map<String, dynamic> toQuery() => {
        'q': q.isEmpty ? null : q,
        'debt': debt ? '1' : null,
        'zalo': zalo ? '1' : null,
        'page': page > 1 ? '$page' : null,
      };

  @override
  bool operator ==(Object other) =>
      other is CustomersFilter && other.q == q && other.debt == debt && other.zalo == zalo && other.page == page;

  @override
  int get hashCode => Object.hash(q, debt, zalo, page);
}

class CustomersFilterNotifier extends Notifier<CustomersFilter> {
  @override
  CustomersFilter build() => const CustomersFilter();

  /// Like submitting the web filter form: back to page 1.
  void apply({required String q, required bool debt, required bool zalo}) {
    final text = q.trim();
    state = CustomersFilter(q: text.length > 60 ? text.substring(0, 60) : text, debt: debt, zalo: zalo);
  }

  /// The 'Còn công nợ' card links to ?debt=1 (other filters dropped).
  void debtOnly() => state = const CustomersFilter(debt: true);

  void clear() => state = const CustomersFilter();

  void goTo(int page) =>
      state = CustomersFilter(q: state.q, debt: state.debt, zalo: state.zalo, page: page < 1 ? 1 : page);
}

final customersFilterProvider =
    NotifierProvider.autoDispose<CustomersFilterNotifier, CustomersFilter>(CustomersFilterNotifier.new);

/// GET /api/admin/customers?q=&debt=1&zalo=1&page=
final customersPageProvider = FutureProvider.autoDispose<CustomerPage>((ref) async {
  final f = ref.watch(customersFilterProvider);
  final res = await ref.watch(apiProvider).get('/admin/customers', query: f.toQuery());
  return CustomerPage.fromJson(res);
}, retry: _noRetry);

/// GET /api/admin/customers/:id
final customerDetailProvider = FutureProvider.autoDispose.family<CustomerDetail, int>((ref, id) async {
  final res = await ref.watch(apiProvider).get('/admin/customers/$id');
  return CustomerDetail.fromJson(res);
}, retry: _noRetry);

/// Period of the reconciliation: null dates = the server default (this month so far).
class ReconQuery {
  const ReconQuery({this.from, this.to, this.q = ''});

  final String? from;
  final String? to;
  final String q;

  Map<String, dynamic> toQuery() => {'from': from, 'to': to, 'q': q.isEmpty ? null : q};

  @override
  bool operator ==(Object other) => other is ReconQuery && other.from == from && other.to == to && other.q == q;

  @override
  int get hashCode => Object.hash(from, to, q);
}

class ReconQueryNotifier extends Notifier<ReconQuery> {
  @override
  ReconQuery build() => const ReconQuery();

  void set({required String? from, required String? to, required String q}) {
    var f = from, t = to;
    if (f != null && t != null && f.compareTo(t) > 0) (f, t) = (t, f); // swapped when reversed, like readPeriod()
    final text = q.trim();
    state = ReconQuery(from: f, to: t, q: text.length > 60 ? text.substring(0, 60) : text);
  }
}

final reconQueryProvider = NotifierProvider.autoDispose<ReconQueryNotifier, ReconQuery>(ReconQueryNotifier.new);

/// GET /api/admin/customers/reconciliation?from=&to=&q=
final reconciliationProvider = FutureProvider.autoDispose<Reconciliation>((ref) async {
  final q = ref.watch(reconQueryProvider);
  final res = await ref.watch(apiProvider).get('/admin/customers/reconciliation', query: q.toQuery());
  return Reconciliation.fromJson(res);
}, retry: _noRetry);

/// After any debt write: list balances, the customer page and the reconciliation are stale.
void invalidateCustomerData(WidgetRef ref, {int? id}) {
  ref.invalidate(customersPageProvider);
  ref.invalidate(reconciliationProvider);
  if (id != null) ref.invalidate(customerDetailProvider(id));
}
