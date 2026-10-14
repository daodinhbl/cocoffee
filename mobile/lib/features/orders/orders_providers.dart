import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import 'orders_models.dart';

/// Status tabs of the web page, in the same order (views/pages/orders.ejs).
enum OrdersTab {
  all('Tất cả', null, null),
  draft('Chờ xác nhận', 'draft', null),
  open('Đang phục vụ', 'open', null),
  unpaid('Chưa thu', 'completed', 'unpaid'),
  completed('Hoàn tất', 'completed', null),
  cancelled('Đã hủy', 'cancelled', null);

  const OrdersTab(this.label, this.status, this.payment);
  final String label;
  final String? status;
  final String? payment;

  int? count(OrderCounts? c) => c == null
      ? null
      : switch (this) {
          OrdersTab.all => c.all,
          OrdersTab.draft => c.draft,
          OrdersTab.open => c.open,
          OrdersTab.unpaid => c.unpaid,
          OrdersTab.completed => c.completed,
          OrdersTab.cancelled => c.cancelled,
        };
}

/// The web's GET filters (?status=&payment=&source=&q=&from=&to=&page=). Days are shop days 'YYYY-MM-DD'.
class OrdersFilter {
  const OrdersFilter({this.status, this.payment, this.source, this.q = '', this.dateFrom, this.dateTo, this.page = 1});

  final String? status;
  final String? payment;
  final String? source;
  final String q;
  final String? dateFrom;
  final String? dateTo;
  final int page;

  OrdersTab? get tab {
    for (final t in OrdersTab.values) {
      if (t.status == status && t.payment == payment) return t;
    }
    return null;
  }

  bool get hasFilter => status != null || payment != null || source != null || q.isNotEmpty || dateFrom != null || dateTo != null;
  bool get hasDates => dateFrom != null || dateTo != null;

  /// Query for GET /api/orders (contract: status, payment, source, q, date_from, date_to, page).
  Map<String, dynamic> toQuery() => {
        'status': status,
        'payment': payment,
        'source': source,
        'q': q,
        'date_from': dateFrom,
        'date_to': dateTo,
        'page': page,
      };

  OrdersFilter copyWith({
    Object? status = _keep,
    Object? payment = _keep,
    Object? source = _keep,
    String? q,
    Object? dateFrom = _keep,
    Object? dateTo = _keep,
    int? page,
  }) =>
      OrdersFilter(
        status: identical(status, _keep) ? this.status : status as String?,
        payment: identical(payment, _keep) ? this.payment : payment as String?,
        source: identical(source, _keep) ? this.source : source as String?,
        q: q ?? this.q,
        dateFrom: identical(dateFrom, _keep) ? this.dateFrom : dateFrom as String?,
        dateTo: identical(dateTo, _keep) ? this.dateTo : dateTo as String?,
        page: page ?? this.page,
      );

  @override
  bool operator ==(Object other) =>
      other is OrdersFilter &&
      other.status == status &&
      other.payment == payment &&
      other.source == source &&
      other.q == q &&
      other.dateFrom == dateFrom &&
      other.dateTo == dateTo &&
      other.page == page;

  @override
  int get hashCode => Object.hash(status, payment, source, q, dateFrom, dateTo, page);
}

const _keep = Object();

/// Today in shop time (UTC+7) as 'YYYY-MM-DD', shifted by [days].
String shopDayIso([int days = 0, DateTime? now]) =>
    isoDay((now ?? DateTime.now()).toUtc().add(const Duration(hours: 7)).add(Duration(days: days)));

/// Screen state: the filters. Kept while the Orders tab lives, so coming back from a detail keeps the view.
class OrdersFilterNotifier extends Notifier<OrdersFilter> {
  @override
  OrdersFilter build() => const OrdersFilter();

  /// Status tabs keep the other filters (tabUrl on the web) and go back to page 1.
  void setTab(OrdersTab tab) => state = state.copyWith(status: tab.status, payment: tab.payment, page: 1);

  void setSource(String? source) => state = state.copyWith(source: source, page: 1);

  void setQuery(String q) {
    final t = q.trim();
    state = state.copyWith(q: t.length > 30 ? t.substring(0, 30) : t, page: 1);
  }

  /// Sets the day range; a reversed range is swapped.
  void setDates(String? from, String? to) {
    var f = from, t = to;
    if (f != null && t != null && f.compareTo(t) > 0) (f, t) = (t, f);
    state = state.copyWith(dateFrom: f, dateTo: t, page: 1);
  }

  void setPage(int page) => state = state.copyWith(page: page < 1 ? 1 : page);

  /// "Xóa": back to /admin/orders with no filter at all.
  void clear() => state = const OrdersFilter();
}

final ordersFilterProvider = NotifierProvider<OrdersFilterNotifier, OrdersFilter>(OrdersFilterNotifier.new);

/// Retries only network hiccups (offline / timeout), never business errors.
Duration? ordersRetry(int count, Object error) {
  final e = toApiException(error);
  if ((e.isOffline || e.code == 'TIMEOUT') && count < 3) return Duration(milliseconds: 500 * (1 << count));
  return null;
}

/// GET /api/orders?status=&payment=&source=&q=&date_from=&date_to=&page= -> { orders, total, page, pages, page_size, counts }
final ordersPageProvider = FutureProvider.autoDispose.family<OrdersPage, OrdersFilter>(
  (ref, filter) async => OrdersPage.fromJson(await ref.watch(apiProvider).get('/orders', query: filter.toQuery())),
  retry: ordersRetry,
);

/// GET /api/orders/:id?include=payments -> { order, payments }
final orderDetailProvider = FutureProvider.autoDispose.family<OrderDetail, int>(
  (ref, id) async => OrderDetail.fromJson(await ref.watch(apiProvider).get('/orders/$id', query: {'include': 'payments'})),
  retry: ordersRetry,
);
