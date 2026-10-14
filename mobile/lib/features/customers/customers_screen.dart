import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'customer_detail_screen.dart' show AdjustSheet;
import 'customer_form_screen.dart';
import 'customer_models.dart';
import 'customer_providers.dart';
import 'customer_widgets.dart';
import 'debt_reconciliation_screen.dart';

/// Khách hàng (views/pages/customers.ejs): summary cards, filter form, result line, table (cards on phones),
/// pagination. Admin only (guarded by the router).
class CustomersScreen extends ConsumerStatefulWidget {
  const CustomersScreen({super.key});

  @override
  ConsumerState<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends ConsumerState<CustomersScreen> {
  final _q = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _q.dispose();
    _scroll.dispose();
    super.dispose();
  }

  CustomersFilterNotifier get _filter => ref.read(customersFilterProvider.notifier);

  void _apply({bool? debt, bool? zalo}) {
    final f = ref.read(customersFilterProvider);
    _filter.apply(q: _q.text, debt: debt ?? f.debt, zalo: zalo ?? f.zalo);
  }

  void _clear() {
    _q.clear();
    _filter.clear();
  }

  void _debtOnly() {
    _q.clear();
    _filter.debtOnly();
  }

  /// A new page starts at the top, like loading the next web page.
  void _goTo(int page) {
    _filter.goTo(page);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  Future<void> _openReconciliation() =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const DebtReconciliationScreen()));

  Future<void> _create() async {
    final created = await Navigator.of(context).push<Customer>(MaterialPageRoute(builder: (_) => const CustomerFormScreen()));
    // Like the web (303 -> /admin/customers/{newId}): open the new customer.
    if (created != null && mounted) await openCustomerDetail(context, created.id);
  }

  Future<void> _edit(Customer c) async {
    await Navigator.of(context).push<Customer>(MaterialPageRoute(builder: (_) => CustomerFormScreen(customer: c)));
  }

  /// 'Ghi nợ' on a row: adds debt to the customer by hand (they are told on Zalo when linked), then the list reloads.
  Future<void> _addDebt(Customer c) async {
    final res = await showFormSheet<Map<String, dynamic>>(context, builder: (_) => AdjustSheet(customer: c, increaseOnly: true));
    if (res == null || !mounted) return;
    ref.invalidate(customersPageProvider);
    showToast(context, adjustMessage(parseNum(res['balance']), res['notify']));
  }

  Future<void> _refresh() async {
    try {
      ref.invalidate(customersPageProvider);
      await ref.read(customersPageProvider.future);
    } catch (_) {
      // the error is shown by the list itself
    }
  }

  @override
  Widget build(BuildContext context) {
    final filter = ref.watch(customersFilterProvider);
    final async = ref.watch(customersPageProvider);
    final data = async.value;
    final wide = isWide(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Khách hàng'),
        actions: [
          if (wide)
            TextButton.icon(onPressed: _openReconciliation, icon: const Icon(Icons.bar_chart_rounded), label: const Text('Đối chiếu công nợ'))
          else
            IconButton(tooltip: 'Đối chiếu công nợ', onPressed: _openReconciliation, icon: const Icon(Icons.bar_chart_rounded)),
          if (wide)
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 16),
              child: FilledButton.icon(onPressed: _create, icon: const Icon(Icons.add_rounded), label: const Text('Thêm khách hàng')),
            ),
        ],
      ),
      floatingActionButton: wide
          ? null
          : FloatingActionButton.extended(
              onPressed: _create,
              backgroundColor: context.co.cta,
              foregroundColor: context.co.onCta,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Thêm khách hàng', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 96),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: Text(
                'Danh bạ khách hàng và sổ công nợ. Bấm vào khách để thu nợ (được thu một phần) hoặc điều chỉnh công nợ.',
                style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
              ),
            ),
            if (data != null) _Stats(stats: data.stats, onDebt: _debtOnly),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
              child: _FilterCard(
                controller: _q,
                filter: filter,
                onSubmit: () => _apply(),
                onDebt: (v) => _apply(debt: v),
                onZalo: (v) => _apply(zalo: v),
                onClear: _clear,
              ),
            ),
            if (async.isLoading && data != null)
              const Padding(padding: EdgeInsets.fromLTRB(16, 10, 16, 0), child: LinearProgressIndicator(minHeight: 2)),
            if (async.hasError && !async.isLoading)
              ErrorPanel(error: async.error!, onRetry: () => ref.invalidate(customersPageProvider))
            else if (data == null)
              const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()))
            else ...[
              Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 10), child: _ResultLine(page: data)),
              if (data.customers.isEmpty)
                Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: _Empty(hasFilter: filter.hasFilter))
              else if (wide)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: _CustomerTable(customers: data.customers, onEdit: _edit, onAddDebt: _addDebt),
                )
              else
                for (final c in data.customers)
                  Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: _CustomerCard(customer: c, onEdit: () => _edit(c), onAddDebt: () => _addDebt(c))),
              PaginationBar(page: data.page, pages: data.pages, onPage: _goTo),
            ],
          ],
        ),
      ),
    );
  }
}

class _Stats extends StatelessWidget {
  const _Stats({required this.stats, required this.onDebt});
  final CustomerStats stats;
  final VoidCallback onDebt;

  @override
  Widget build(BuildContext context) {
    return StatGrid(children: [
      StatCard(
        label: 'Tổng khách hàng',
        value: '${stats.totalCustomers}',
        sub: 'Trong hệ thống',
        icon: Icons.groups_rounded,
      ),
      StatCard(
        label: 'Còn công nợ',
        value: '${stats.debtCustomers}',
        sub: stats.debtCustomers > 0 ? 'Khách đang nợ →' : 'Không có nợ',
        icon: Icons.receipt_long_rounded,
        tone: Tone.warn,
        valueColor: stats.debtCustomers > 0 ? context.co.warn : null,
        onTap: onDebt,
      ),
      StatCard(
        label: 'Tổng công nợ',
        value: money(stats.totalDebt),
        sub: 'Tổng số dư tất cả nợ',
        icon: Icons.bar_chart_rounded,
        tone: Tone.bad,
        valueColor: stats.totalDebt > 0 ? context.co.bad : null,
      ),
    ]);
  }
}

class _FilterCard extends StatelessWidget {
  const _FilterCard({
    required this.controller,
    required this.filter,
    required this.onSubmit,
    required this.onDebt,
    required this.onZalo,
    required this.onClear,
  });
  final TextEditingController controller;
  final CustomersFilter filter;
  final VoidCallback onSubmit;
  final ValueChanged<bool> onDebt;
  final ValueChanged<bool> onZalo;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final search = TextField(
      controller: controller,
      textInputAction: TextInputAction.search,
      onSubmitted: (_) => onSubmit(),
      inputFormatters: [LengthLimitingTextInputFormatter(60)],
      decoration: const InputDecoration(
        hintText: 'Tên, số điện thoại hoặc Zalo ID',
        prefixIcon: Icon(Icons.search_rounded, size: 20),
      ),
    );
    final debt = SelectBox<bool>(
      semanticLabel: 'Lọc công nợ',
      value: filter.debt,
      items: const {false: 'Mọi khách', true: 'Còn nợ'},
      onChanged: onDebt,
    );
    final zalo = SelectBox<bool>(
      semanticLabel: 'Lọc Zalo',
      value: filter.zalo,
      items: const {false: 'Mọi kênh', true: 'Có Zalo'},
      onChanged: onZalo,
    );
    final buttons = Row(children: [
      Expanded(child: FilledButton(onPressed: onSubmit, child: const Text('Lọc'))),
      if (filter.hasFilter) ...[
        const SizedBox(width: 8),
        Tooltip(message: 'Xóa bộ lọc', child: OutlinedButton(onPressed: onClear, child: const Text('Xóa'))),
      ],
    ]);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: LayoutBuilder(builder: (context, c) {
          if (c.maxWidth >= 720) {
            return Row(children: [
              Expanded(flex: 5, child: search),
              const SizedBox(width: 12),
              Expanded(flex: 2, child: debt),
              const SizedBox(width: 12),
              Expanded(flex: 2, child: zalo),
              const SizedBox(width: 12),
              Expanded(flex: 3, child: buttons),
            ]);
          }
          return Column(children: [
            search,
            const SizedBox(height: 10),
            Row(children: [Expanded(child: debt), const SizedBox(width: 10), Expanded(child: zalo)]),
            const SizedBox(height: 10),
            buttons,
          ]);
        }),
      ),
    );
  }
}

class _ResultLine extends StatelessWidget {
  const _ResultLine({required this.page});
  final CustomerPage page;

  @override
  Widget build(BuildContext context) {
    final muted = context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14);
    if (page.total == 0) return Text('Không tìm thấy khách hàng nào.', style: muted);
    return Text.rich(
      TextSpan(style: muted, children: [
        const TextSpan(text: 'Hiển thị '),
        TextSpan(
            text: '${page.from}–${page.to}',
            style: TextStyle(fontFeatures: tabular, fontWeight: FontWeight.w600, color: context.cs.onSurface)),
        const TextSpan(text: ' / '),
        TextSpan(text: '${page.total}', style: const TextStyle(fontFeatures: tabular)),
        const TextSpan(text: ' khách hàng'),
      ]),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.hasFilter});
  final bool hasFilter;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 44, horizontal: 20),
        child: Column(children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(color: context.co.neutralTint, shape: BoxShape.circle),
            child: Icon(Icons.groups_rounded, size: 28, color: context.co.muted),
          ),
          const SizedBox(height: 12),
          const Text('Không có khách hàng nào', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text(hasFilter ? 'Thử bỏ bớt bộ lọc.' : 'Thêm khách hàng đầu tiên bằng nút bên trên.',
              textAlign: TextAlign.center, style: context.tt.bodySmall?.copyWith(fontSize: 14)),
        ]),
      ),
    );
  }
}

class _Contact extends StatelessWidget {
  const _Contact({required this.customer, this.alignEnd = false});
  final Customer customer;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    final c = customer;
    if (c.phone == null && !c.hasZalo) return Text('—', style: TextStyle(color: context.co.muted));
    return Wrap(
      alignment: alignEnd ? WrapAlignment.end : WrapAlignment.start,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 6,
      runSpacing: 4,
      children: [
        if (c.phone != null) Text(c.phone!, style: const TextStyle(fontFeatures: tabular, fontSize: 14)),
        if (c.hasZalo) const ZaloBadge(),
      ],
    );
  }
}

Widget _balanceText(BuildContext context, num balance, {double size = 15}) => Text(
      money(balance),
      style: TextStyle(
        fontFeatures: tabular,
        fontWeight: FontWeight.w700,
        fontSize: size,
        color: balance > 0 ? context.co.bad : Palette.navyDarker,
      ),
    );

/// Phone: the web's rtable card (title = name + note; rows Liên hệ, Đơn hàng, Số dư nợ, Cập nhật; actions).
class _CustomerCard extends StatelessWidget {
  const _CustomerCard({required this.customer, required this.onEdit, required this.onAddDebt});
  final Customer customer;
  final VoidCallback onEdit;
  final VoidCallback onAddDebt;

  @override
  Widget build(BuildContext context) {
    final c = customer;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => openCustomerDetail(context, c.id),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            LinkText(c.name, bold: true, size: 16),
            if (c.note != null)
              Text(c.note!, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall),
            const SizedBox(height: 6),
            KeyValueRow(label: 'Liên hệ', child: _Contact(customer: c, alignEnd: true)),
            KeyValueRow(
              label: 'Đơn hàng',
              child: Text('${c.orderCount}', style: TextStyle(fontFeatures: tabular, color: context.co.muted)),
            ),
            KeyValueRow(label: 'Số dư nợ', child: _balanceText(context, c.balance)),
            KeyValueRow(
              label: 'Cập nhật',
              child: Text(shopTime(c.updatedAt), style: context.tt.bodySmall?.copyWith(fontSize: 13, fontFeatures: tabular)),
            ),
            const Divider(height: 12),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              TextButton.icon(
                key: ValueKey('add-debt-${c.id}'),
                onPressed: onAddDebt,
                icon: const Icon(Icons.add_card_rounded, size: 19),
                label: const Text('Ghi nợ'),
              ),
              IconButton(tooltip: 'Sửa khách hàng', onPressed: onEdit, icon: const Icon(Icons.edit_outlined, size: 20)),
              const SizedBox(width: 4),
              OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(64, 38), foregroundColor: Palette.navy),
                onPressed: () => openCustomerDetail(context, c.id),
                child: const Text('Xem'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// Tablet: the web table (Tên khách hàng, Liên hệ / Zalo, Đơn hàng, Số dư nợ, Cập nhật, actions).
class _CustomerTable extends StatelessWidget {
  const _CustomerTable({required this.customers, required this.onEdit, required this.onAddDebt});
  final List<Customer> customers;
  final ValueChanged<Customer> onEdit;
  final ValueChanged<Customer> onAddDebt;

  static const _flex = [30, 22, 10, 14, 16];

  @override
  Widget build(BuildContext context) {
    final head = context.tt.labelSmall;
    Widget th(String t, int flex, {bool end = false}) =>
        Expanded(flex: flex, child: Text(t.toUpperCase(), style: head, textAlign: end ? TextAlign.right : TextAlign.left));
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(children: [
        Container(
          color: Palette.milk50,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(children: [
            th('Tên khách hàng', _flex[0]),
            th('Liên hệ / Zalo', _flex[1]),
            th('Đơn hàng', _flex[2], end: true),
            th('Số dư nợ', _flex[3], end: true),
            const SizedBox(width: 16),
            th('Cập nhật', _flex[4]),
            const SizedBox(width: 184),
          ]),
        ),
        const Divider(),
        for (var i = 0; i < customers.length; i++) ...[
          if (i > 0) const Divider(),
          _row(context, customers[i]),
        ],
      ]),
    );
  }

  Widget _row(BuildContext context, Customer c) {
    return InkWell(
      onTap: () => openCustomerDetail(context, c.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(children: [
          Expanded(
            flex: _flex[0],
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              LinkText(c.name),
              if (c.note != null) Text(c.note!, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall),
            ]),
          ),
          Expanded(flex: _flex[1], child: _Contact(customer: c)),
          Expanded(
            flex: _flex[2],
            child: Text('${c.orderCount}', textAlign: TextAlign.right, style: TextStyle(fontFeatures: tabular, color: context.co.muted)),
          ),
          Expanded(flex: _flex[3], child: Align(alignment: Alignment.centerRight, child: _balanceText(context, c.balance, size: 14.5))),
          const SizedBox(width: 16),
          Expanded(
            flex: _flex[4],
            child: Text(shopTime(c.updatedAt), style: context.tt.bodySmall?.copyWith(fontSize: 13.5, fontFeatures: tabular)),
          ),
          SizedBox(
            width: 184,
            child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              IconButton(key: ValueKey('add-debt-${c.id}'), tooltip: 'Ghi nợ', onPressed: () => onAddDebt(c), icon: const Icon(Icons.add_card_rounded, size: 19)),
              IconButton(tooltip: 'Sửa khách hàng', onPressed: () => onEdit(c), icon: const Icon(Icons.edit_outlined, size: 19)),
              OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(52, 36), padding: const EdgeInsets.symmetric(horizontal: 12), foregroundColor: Palette.navy),
                onPressed: () => openCustomerDetail(context, c.id),
                child: const Text('Xem', style: TextStyle(fontSize: 13)),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}
