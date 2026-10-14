import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'order_widgets.dart';
import 'orders_models.dart';
import 'orders_providers.dart';

/// Content width from which the order list becomes a real table (the web's lg rtable).
const _kTableWidth = 900.0;

Color _link(BuildContext c) => Theme.of(c).brightness == Brightness.light ? Palette.navyAccent : c.cs.primary;
Color _strong(BuildContext c) => Theme.of(c).brightness == Brightness.light ? Palette.navyDarker : c.cs.onSurface;

/// Đơn hàng (views/pages/orders.ejs): summary cards, status tabs, filters, order list, pages.
class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key});

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  final _q = TextEditingController();
  final _scroll = ScrollController();

  /// Last page shown, kept on screen (with a thin progress bar) while another filter or page loads.
  OrdersPage? _last;

  @override
  void initState() {
    super.initState();
    _q.text = ref.read(ordersFilterProvider).q;
  }

  @override
  void dispose() {
    _q.dispose();
    _scroll.dispose();
    super.dispose();
  }

  OrdersFilterNotifier get _filters => ref.read(ordersFilterProvider.notifier);

  void _open(OrderRow o) => context.push('/orders/${o.id}');

  Future<void> _refresh() async {
    final next = ref.refresh(ordersPageProvider(ref.read(ordersFilterProvider)).future);
    try {
      await next;
    } catch (_) {
      // the error is shown in the list area
    }
  }

  void _applyQuery() {
    FocusScope.of(context).unfocus();
    _filters.setQuery(_q.text);
  }

  void _clear() {
    _q.clear();
    _filters.clear();
  }

  void _goPage(int page) {
    _filters.setPage(page);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  @override
  Widget build(BuildContext context) {
    // A link such as /orders?status=draft (dashboard, bell) resets the filters from outside: keep the box in step.
    ref.listen(ordersFilterProvider.select((f) => f.q), (_, next) {
      if (_q.text != next) _q.text = next;
    });
    final filter = ref.watch(ordersFilterProvider);
    final async = ref.watch(ordersPageProvider(filter));
    if (async.hasValue && !async.hasError) _last = async.value;
    final data = async.hasError ? null : (async.value ?? _last);
    final counts = data?.counts ?? _last?.counts;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Đơn hàng'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: FilledButton.icon(
              onPressed: () => context.push('/pos'),
              icon: const Icon(Icons.shopping_cart_outlined, size: 20),
              label: const Text('Bán hàng (POS)'),
              style: FilledButton.styleFrom(minimumSize: const Size(0, 40), padding: const EdgeInsets.symmetric(horizontal: 12)),
            ),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: LayoutBuilder(builder: (context, c) {
          final width = c.maxWidth;
          return ListView(
            key: const Key('orders-list'),
            controller: _scroll,
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 28),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Text('Đơn từ máy POS và chatbot Zalo. Bấm vào mã đơn để xem món, thu tiền, in hóa đơn hoặc hủy.',
                    style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
              ),
              if (counts != null) ...[
                const SizedBox(height: 16),
                _SummaryCards(
                  counts: counts,
                  hasDates: filter.hasDates,
                  onUnpaid: () => _filters.setTab(OrdersTab.unpaid),
                  onOpen: () => _filters.setTab(OrdersTab.open),
                ),
              ],
              const SizedBox(height: 16),
              _StatusTabs(current: filter.tab, counts: counts, onTap: _filters.setTab),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: _FilterCard(
                  filter: filter,
                  query: _q,
                  onApply: _applyQuery,
                  onClear: _clear,
                  onSource: _filters.setSource,
                  onDates: _filters.setDates,
                ),
              ),
              if (data != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                  child: Text(
                    data.total > 0 ? 'Hiển thị ${data.firstIndex}–${data.lastIndex} / ${data.total} đơn' : 'Không có đơn phù hợp.',
                    style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14, fontFeatures: tabular),
                  ),
                ),
              const SizedBox(height: 10),
              if (data == null)
                async.hasError
                    ? ErrorPanel(error: async.error!, onRetry: () => ref.invalidate(ordersPageProvider(filter)))
                    : const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
              else ...[
                if (async.isLoading)
                  const Padding(padding: EdgeInsets.fromLTRB(16, 0, 16, 6), child: LinearProgressIndicator(minHeight: 2)),
                if (data.orders.isEmpty)
                  _EmptyOrders(hasFilter: filter.hasFilter)
                else if (width >= _kTableWidth)
                  Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: _OrdersTable(orders: data.orders, onOpen: _open))
                else
                  _OrderCards(orders: data.orders, width: width, onOpen: _open),
                if (data.pages > 1) _Pagination(page: data.page, pages: data.pages, onPage: _goPage),
              ],
            ],
          );
        }),
      ),
    );
  }
}

class _SummaryCards extends StatelessWidget {
  const _SummaryCards({required this.counts, required this.hasDates, required this.onUnpaid, required this.onOpen});
  final OrderCounts counts;
  final bool hasDates;
  final VoidCallback onUnpaid;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final period = hasDates ? 'Trong khoảng ngày đã chọn' : 'Tất cả thời gian';
    return StatGrid(minTileWidth: 200, children: [
      StatCard(
        label: 'Tổng số đơn',
        value: vnd(counts.all),
        sub: '$period · ${counts.draft} chờ xác nhận',
        icon: Icons.receipt_long_outlined,
        tone: Tone.info,
      ),
      StatCard(
        label: 'Doanh thu hoàn tất',
        value: money(counts.revenue),
        sub: '${vnd(counts.completed)} đơn hoàn tất',
        icon: Icons.bar_chart_rounded,
        tone: Tone.good,
      ),
      StatCard(
        label: 'Cần thu tiền',
        value: money(counts.unpaidAmount),
        valueColor: counts.unpaidAmount > 0 ? context.co.warn : null,
        sub: '${vnd(counts.unpaid)} đơn đã giao · Xem danh sách →',
        icon: Icons.notifications_none_rounded,
        tone: Tone.warn,
        onTap: onUnpaid,
      ),
      StatCard(
        label: 'Đang phục vụ',
        value: money(counts.openAmount),
        sub: '${vnd(counts.open)} đơn đang mở · Xem danh sách →',
        icon: Icons.local_cafe_outlined,
        tone: Tone.info,
        onTap: onOpen,
      ),
    ]);
  }
}

class _StatusTabs extends StatelessWidget {
  const _StatusTabs({required this.current, required this.counts, required this.onTap});
  final OrdersTab? current;
  final OrderCounts? counts;
  final ValueChanged<OrdersTab> onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 42,
      child: ListView.separated(
        key: const Key('orders-tabs'),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        scrollDirection: Axis.horizontal,
        itemCount: OrdersTab.values.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final t = OrdersTab.values[i];
          final n = t.count(counts);
          return CountPill(
            label: t.label,
            count: n,
            selected: current == t,
            countTone: t == OrdersTab.unpaid && (n ?? 0) > 0 ? Tone.warn : null,
            onTap: () => onTap(t),
          );
        },
      ),
    );
  }
}

class _FilterCard extends StatelessWidget {
  const _FilterCard({
    required this.filter,
    required this.query,
    required this.onApply,
    required this.onClear,
    required this.onSource,
    required this.onDates,
  });

  final OrdersFilter filter;
  final TextEditingController query;
  final VoidCallback onApply;
  final VoidCallback onClear;
  final ValueChanged<String?> onSource;
  final void Function(String? from, String? to) onDates;

  @override
  Widget build(BuildContext context) {
    final today = shopDayIso();
    final weekAgo = shopDayIso(-6);

    final search = TextField(
      key: const Key('orders-q'),
      controller: query,
      textInputAction: TextInputAction.search,
      autocorrect: false,
      inputFormatters: [LengthLimitingTextInputFormatter(30)],
      onSubmitted: (_) => onApply(),
      decoration: const InputDecoration(
        hintText: 'Tìm mã đơn (VD: CF261013)',
        prefixIcon: Icon(Icons.search_rounded, size: 20),
      ),
    );
    final source = DropdownButtonFormField<String?>(
      key: ValueKey('orders-source-${filter.source}'),
      initialValue: filter.source,
      isExpanded: true,
      decoration: const InputDecoration(),
      items: const [
        DropdownMenuItem(value: null, child: Text('Mọi kênh')),
        DropdownMenuItem(value: 'pos', child: Text('POS')),
        DropdownMenuItem(value: 'zalo', child: Text('Zalo')),
      ],
      onChanged: onSource,
    );
    final from = _DateField(
      hint: 'Từ ngày',
      value: filter.dateFrom,
      onPick: (d) => onDates(d, filter.dateTo),
      onClear: () => onDates(null, filter.dateTo),
    );
    final to = _DateField(
      hint: 'Đến ngày',
      value: filter.dateTo,
      onPick: (d) => onDates(filter.dateFrom, d),
      onClear: () => onDates(filter.dateFrom, null),
    );
    final buttons = Row(children: [
      Expanded(child: FilledButton(onPressed: onApply, child: const Text('Lọc'))),
      if (filter.hasFilter) ...[
        const SizedBox(width: 8),
        OutlinedButton(onPressed: onClear, child: const Text('Xóa')),
      ],
    ]);
    final quick = Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Text('Nhanh:', style: context.tt.bodySmall),
      _QuickChip(
        label: 'Hôm nay',
        selected: filter.dateFrom == today && filter.dateTo == today,
        onTap: () => onDates(today, today),
      ),
      _QuickChip(
        label: '7 ngày',
        selected: filter.dateFrom == weekAgo && filter.dateTo == today,
        onTap: () => onDates(weekAgo, today),
      ),
    ]);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: LayoutBuilder(builder: (context, c) {
          if (c.maxWidth >= 720) {
            return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(flex: 4, child: search),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: source),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: from),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: to),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: buttons),
              ]),
              const SizedBox(height: 10),
              quick,
            ]);
          }
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            search,
            const SizedBox(height: 10),
            source,
            const SizedBox(height: 10),
            Row(children: [Expanded(child: from), const SizedBox(width: 10), Expanded(child: to)]),
            const SizedBox(height: 10),
            buttons,
            const SizedBox(height: 10),
            quick,
          ]);
        }),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  const _DateField({required this.hint, required this.value, required this.onPick, required this.onClear});
  final String hint;
  final String? value;
  final ValueChanged<String> onPick;
  final VoidCallback onClear;

  Future<void> _pick(BuildContext context) async {
    final initial = DateTime.tryParse(value ?? '') ?? DateTime.tryParse(shopDayIso()) ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      helpText: hint,
      cancelText: 'Hủy',
      confirmText: 'Chọn',
    );
    if (picked != null) onPick(isoDay(picked));
  }

  @override
  Widget build(BuildContext context) {
    final has = value != null;
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => _pick(context),
      child: InputDecorator(
        isEmpty: !has,
        decoration: InputDecoration(
          hintText: hint,
          prefixIcon: const Icon(Icons.calendar_today_outlined, size: 18),
          suffixIcon: has
              ? IconButton(tooltip: 'Bỏ ngày', icon: const Icon(Icons.close_rounded, size: 18), onPressed: onClear)
              : null,
        ),
        child: Text(has ? dayLabel(value) : '', style: const TextStyle(fontFeatures: tabular)),
      ),
    );
  }
}

class _QuickChip extends StatelessWidget {
  const _QuickChip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? context.co.infoTint : Colors.transparent,
      shape: StadiumBorder(side: BorderSide(color: selected ? Palette.navyAccent : context.co.line)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Text(label,
              style: TextStyle(
                  fontSize: 13, fontWeight: FontWeight.w600, color: selected ? context.cs.primary : context.cs.onSurface)),
        ),
      ),
    );
  }
}

class _EmptyOrders extends StatelessWidget {
  const _EmptyOrders({required this.hasFilter});
  final bool hasFilter;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 36),
      child: Column(children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(color: context.co.neutralTint, shape: BoxShape.circle),
          child: Icon(Icons.receipt_long_outlined, size: 28, color: context.co.muted),
        ),
        const SizedBox(height: 12),
        Text('Không có đơn nào', style: context.tt.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        Text(hasFilter ? 'Thử bỏ bớt bộ lọc.' : 'Đơn từ POS và Zalo sẽ hiện ở đây.',
            textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
      ]),
    );
  }
}

/// Phone: one card per order (rtable cards); 2 columns from 600 dp.
class _OrderCards extends StatelessWidget {
  const _OrderCards({required this.orders, required this.width, required this.onOpen});
  final List<OrderRow> orders;
  final double width;
  final ValueChanged<OrderRow> onOpen;

  @override
  Widget build(BuildContext context) {
    final cols = width >= 600 ? 2 : 1;
    final w = (width - 32 - 12 * (cols - 1)) / cols;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Wrap(spacing: 12, runSpacing: 10, children: [
        for (final o in orders) SizedBox(width: w, child: _OrderCard(order: o, onOpen: () => onOpen(o))),
      ]),
    );
  }
}

class _OrderCard extends ConsumerWidget {
  const _OrderCard({required this.order, required this.onOpen});
  final OrderRow order;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final o = order;
    return Card(
      key: ValueKey('order-${o.id}'),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(o.orderCode, style: TextStyle(fontFamily: kMono, fontSize: 14, fontWeight: FontWeight.w700, color: _link(context))),
            const SizedBox(height: 2),
            Text(shopTime(o.createdAt), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
            const SizedBox(height: 8),
            _Field(label: 'Kênh', child: SourceBadge(source: o.source, dense: true)),
            _Field(label: 'Bàn / Khách', child: _Who(order: o, alignEnd: true)),
            _Field(
              label: 'Món',
              child: Text(qty(o.itemCount), style: TextStyle(color: context.co.muted, fontFeatures: tabular)),
            ),
            _Field(
              label: 'Tổng tiền',
              child: Text(money(o.total),
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5, color: _strong(context), fontFeatures: tabular)),
            ),
            _Field(label: 'Trạng thái', child: _StatusCell(order: o, alignEnd: true)),
            const DashedDivider(),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              if (o.printable)
                IconButton(
                  tooltip: 'In hóa đơn ${o.orderCode}',
                  icon: Icon(Icons.receipt_outlined, size: 20, color: context.co.muted),
                  onPressed: () => openReceipt(context, ref, o.id),
                ),
              const SizedBox(width: 4),
              _ViewButton(onPressed: onOpen),
            ]),
          ]),
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const DashedDivider(),
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(children: [
          Text(label.toUpperCase(), style: context.tt.labelSmall),
          const SizedBox(width: 12),
          Expanded(child: Align(alignment: Alignment.centerRight, child: child)),
        ]),
      ),
    ]);
  }
}

class _Who extends StatelessWidget {
  const _Who({required this.order, this.alignEnd = false});
  final OrderRow order;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    final o = order;
    final named = o.customerName != null;
    return Column(
      crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(o.who,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                fontWeight: named ? FontWeight.w600 : FontWeight.w400, color: named ? context.cs.onSurface : context.co.muted)),
        if (named && o.tableCode != null) Text('Bàn ${o.tableCode}', style: context.tt.bodySmall),
      ],
    );
  }
}

class _StatusCell extends StatelessWidget {
  const _StatusCell({required this.order, this.alignEnd = false});
  final OrderRow order;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      alignment: alignEnd ? WrapAlignment.end : WrapAlignment.start,
      spacing: 4,
      runSpacing: 4,
      children: [
        OrderStatusBadge(status: order.status, paymentStatus: order.paymentStatus, dense: true),
        if (order.receiptError != null) const StatusBadge('Bill lỗi', tone: Tone.bad, dense: true),
      ],
    );
  }
}

class _ViewButton extends StatelessWidget {
  const _ViewButton({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(0, 36),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        foregroundColor: context.cs.primary,
        side: BorderSide(color: context.co.line),
        textStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w600, fontSize: 13),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      child: const Text('Xem'),
    );
  }
}

/// Wide layout: the web's table (Mã đơn, Kênh, Bàn / Khách, Món, Tổng tiền, Trạng thái, actions).
class _OrdersTable extends ConsumerWidget {
  const _OrdersTable({required this.orders, required this.onOpen});
  final List<OrderRow> orders;
  final ValueChanged<OrderRow> onOpen;

  static const _flex = [3, 2, 3, 1, 2, 3, 2];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Widget cell(int i, Widget child, {bool end = false}) =>
        Expanded(flex: _flex[i], child: Align(alignment: end ? Alignment.centerRight : Alignment.centerLeft, child: child));
    Widget head(int i, String text, {bool end = false}) => cell(i, Text(text.toUpperCase(), style: context.tt.labelSmall), end: end);

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          color: context.cs.surfaceContainerLow,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(children: [
            head(0, 'Mã đơn'),
            head(1, 'Kênh'),
            head(2, 'Bàn / Khách'),
            head(3, 'Món', end: true),
            head(4, 'Tổng tiền', end: true),
            const SizedBox(width: 16),
            head(5, 'Trạng thái'),
            cell(6, const SizedBox.shrink()),
          ]),
        ),
        for (final o in orders)
          InkWell(
            key: ValueKey('order-${o.id}'),
            onTap: () => onOpen(o),
            child: Container(
              decoration: BoxDecoration(border: Border(top: BorderSide(color: context.co.line))),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(children: [
                cell(
                  0,
                  Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(o.orderCode,
                        style: TextStyle(fontFamily: kMono, fontSize: 13, fontWeight: FontWeight.w700, color: _link(context))),
                    Text(shopTime(o.createdAt), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
                  ]),
                ),
                cell(1, SourceBadge(source: o.source, dense: true)),
                cell(2, _Who(order: o)),
                cell(3, Text(qty(o.itemCount), style: TextStyle(color: context.co.muted, fontFeatures: tabular)), end: true),
                cell(
                  4,
                  Text(money(o.total), style: TextStyle(fontWeight: FontWeight.w700, color: _strong(context), fontFeatures: tabular)),
                  end: true,
                ),
                const SizedBox(width: 16),
                cell(5, _StatusCell(order: o)),
                cell(
                  6,
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    if (o.printable)
                      IconButton(
                        tooltip: 'In hóa đơn ${o.orderCode}',
                        icon: Icon(Icons.receipt_outlined, size: 19, color: context.co.muted),
                        onPressed: () => openReceipt(context, ref, o.id),
                      ),
                    _ViewButton(onPressed: () => onOpen(o)),
                  ]),
                  end: true,
                ),
              ]),
            ),
          ),
      ]),
    );
  }
}

/// "← Trước 1 … 4 5 6 … 12 Sau →" like the web (first, last, current ± 1).
class _Pagination extends StatelessWidget {
  const _Pagination({required this.page, required this.pages, required this.onPage});
  final int page;
  final int pages;
  final ValueChanged<int> onPage;

  @override
  Widget build(BuildContext context) {
    final nums = {1, page - 1, page, page + 1, pages}.where((n) => n >= 1 && n <= pages).toList()..sort();
    final items = <Widget>[
      if (page > 1) _PageButton(label: '← Trước', onTap: () => onPage(page - 1)),
    ];
    for (var i = 0; i < nums.length; i++) {
      if (i > 0 && nums[i] - nums[i - 1] > 1) {
        items.add(Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 10),
          child: Text('…', style: TextStyle(color: context.co.muted)),
        ));
      }
      final n = nums[i];
      items.add(_PageButton(key: ValueKey('page-$n'), label: '$n', selected: n == page, onTap: () => onPage(n)));
    }
    if (page < pages) items.add(_PageButton(label: 'Sau →', onTap: () => onPage(page + 1)));
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Wrap(alignment: WrapAlignment.center, spacing: 6, runSpacing: 6, children: items),
    );
  }
}

class _PageButton extends StatelessWidget {
  const _PageButton({super.key, required this.label, required this.onTap, this.selected = false});
  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Palette.navy : context.cs.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(color: selected ? Palette.navy : context.co.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: selected ? null : onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(
              widthFactor: 1,
              heightFactor: 1,
              child: Text(label,
              style: TextStyle(
                  fontFeatures: tabular,
                  fontSize: 14,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  color: selected ? Colors.white : context.cs.onSurface)),
            ),
          ),
        ),
      ),
    );
  }
}
