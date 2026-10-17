import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'expense_form_screen.dart';
import 'finance_data.dart';

String _viDay(String iso) => iso.length >= 10 ? '${iso.substring(8, 10)}/${iso.substring(5, 7)}' : iso;
String _iso(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// "Sổ chi phí": filters, totals, keyset-paged list; tap a row for detail / edit / void / receipt photo.
class ExpensesScreen extends ConsumerStatefulWidget {
  const ExpensesScreen({super.key});
  @override
  ConsumerState<ExpensesScreen> createState() => _ExpensesScreenState();
}

class _ExpensesScreenState extends ConsumerState<ExpensesScreen> {
  final _scroll = ScrollController();
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) ref.read(expenseListProvider.notifier).loadMore();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    _search.dispose();
    super.dispose();
  }

  void _set(ExpenseFilter f) {
    ref.read(expenseFilterProvider.notifier).set(f);
    ref.invalidate(expenseListProvider);
  }

  Future<void> _open(Expense e) async {
    await showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => _ExpenseSheet(expense: e));
  }

  Future<void> _add() async {
    await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const ExpenseFormScreen()));
  }

  Future<void> _pickRange() async {
    final f = ref.read(expenseFilterProvider);
    final now = DateTime.now();
    final r = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2024),
      lastDate: now.add(const Duration(days: 1)),
      initialDateRange: f.from != null && f.to != null ? DateTimeRange(start: DateTime.parse(f.from!), end: DateTime.parse(f.to!)) : null,
    );
    if (r != null) _set(f.copyWith(from: _iso(r.start), to: _iso(r.end)));
  }

  @override
  Widget build(BuildContext context) {
    final f = ref.watch(expenseFilterProvider);
    final page = ref.watch(expenseListProvider);
    final cats = ref.watch(expenseCategoriesProvider).value ?? const [];
    return Scaffold(
      appBar: AppBar(title: const Text('Sổ chi phí')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.add_rounded), label: const Text('Thêm chi phí')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(expenseCategoriesProvider);
          await ref.read(expenseListProvider.notifier).reload();
        },
        child: ListView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
          children: [
            TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: 'Tìm theo người nhận, số chứng từ, ghi chú…',
                prefixIcon: const Icon(Icons.search_rounded),
                suffixIcon: f.q.isEmpty ? null : IconButton(icon: const Icon(Icons.close_rounded), onPressed: () { _search.clear(); _set(f.copyWith(q: '')); }),
              ),
              onSubmitted: (v) => _set(f.copyWith(q: v)),
            ),
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 6, children: [
              ActionChip(
                avatar: const Icon(Icons.date_range_rounded, size: 18),
                label: Text(f.from == null ? 'Mọi ngày' : '${_viDay(f.from!)} – ${_viDay(f.to ?? f.from!)}'),
                onPressed: _pickRange,
              ),
              if (f.from != null) ActionChip(label: const Text('Bỏ lọc ngày'), onPressed: () => _set(f.copyWith(clearRange: true))),
              PopupMenuButton<int?>(
                tooltip: 'Nhóm chi phí',
                onSelected: (v) => _set(v == null ? f.copyWith(clearCat: true) : f.copyWith(categoryId: v)),
                itemBuilder: (_) => [const PopupMenuItem(value: null, child: Text('Mọi nhóm')), for (final c in cats) PopupMenuItem(value: c.id, child: Text(c.name))],
                child: Chip(
                  avatar: const Icon(Icons.category_rounded, size: 18),
                  label: Text(cats.where((c) => c.id == f.categoryId).map((c) => c.name).firstOrNull ?? 'Mọi nhóm'),
                ),
              ),
              FilterChip(label: const Text('Chi tay'), selected: f.source == 'manual', onSelected: (s) => _set(s ? f.copyWith(source: 'manual') : f.copyWith(clearSource: true))),
              FilterChip(label: const Text('Từ phiếu nhập'), selected: f.source == 'purchase', onSelected: (s) => _set(s ? f.copyWith(source: 'purchase') : f.copyWith(clearSource: true))),
              FilterChip(label: const Text('Cả khoản đã hủy'), selected: f.showVoid, onSelected: (s) => _set(f.copyWith(showVoid: s))),
            ]),
            const SizedBox(height: 12),
            AsyncBody(
              value: page,
              onRetry: () => ref.invalidate(expenseListProvider),
              data: (p) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                StatGrid(children: [
                  StatCard(label: 'Tổng chi', value: money(p.totals.amount), sub: '${p.totals.count} khoản', icon: Icons.payments_rounded),
                  StatCard(label: 'Được trừ khi tính thuế', value: money(p.totals.deductible), icon: Icons.receipt_long_rounded, tone: Tone.good),
                  StatCard(label: 'Chi tay', value: money(p.totals.manual), icon: Icons.edit_note_rounded),
                  StatCard(label: 'Từ phiếu nhập', value: money(p.totals.purchases), icon: Icons.inventory_2_rounded),
                ]),
                const SizedBox(height: 12),
                if (p.items.isEmpty)
                  const EmptyState(text: 'Chưa có khoản chi nào trong bộ lọc này.', icon: Icons.account_balance_wallet_outlined)
                else
                  Card(
                    child: Column(children: [
                      for (var i = 0; i < p.items.length; i++) ...[
                        if (i > 0) const Divider(height: 1),
                        _ExpenseTile(e: p.items[i], onTap: () => _open(p.items[i])),
                      ],
                      if (p.nextBeforeId != null) const Padding(padding: EdgeInsets.all(14), child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)))),
                    ]),
                  ),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

class _ExpenseTile extends StatelessWidget {
  const _ExpenseTile({required this.e, required this.onTap});
  final Expense e;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final who = [if (e.payee.isNotEmpty) e.payee, if (e.docNo.isNotEmpty) 'CT ${e.docNo}', if (e.note.isNotEmpty) e.note].join(' · ');
    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: e.fromPurchase ? context.co.infoTint : context.co.warnTint,
        child: Icon(e.fromPurchase ? Icons.inventory_2_rounded : Icons.payments_rounded, size: 20, color: e.fromPurchase ? context.co.info : context.co.warn),
      ),
      title: Text(e.category, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('${_viDay(e.date)}${who.isEmpty ? '' : ' · $who'}', maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(
          money(e.amount),
          style: TextStyle(fontWeight: FontWeight.w700, decoration: e.isVoid ? TextDecoration.lineThrough : null, color: e.isVoid ? context.co.muted : null),
        ),
        if (e.isVoid) const StatusBadge('Đã hủy', tone: Tone.bad, dense: true) else if (e.hasReceipt) Icon(Icons.photo_rounded, size: 16, color: context.co.muted),
      ]),
    );
  }
}

class _ExpenseSheet extends ConsumerWidget {
  const _ExpenseSheet({required this.expense});
  final Expense expense;

  Widget _row(BuildContext context, String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(k, style: context.tt.bodySmall)),
          Expanded(child: Text(v.isEmpty ? '—' : v)),
        ]),
      );

  Future<void> _void(BuildContext context, WidgetRef ref) async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Hủy khoản chi này?'),
        content: TextField(controller: reason, autofocus: true, maxLength: 200, decoration: const InputDecoration(labelText: 'Lý do hủy')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Giữ lại')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Hủy khoản chi')),
        ],
      ),
    );
    final text = reason.text.trim();
    reason.dispose();
    if (ok != true || !context.mounted) return;
    if (text.isEmpty) {
      showToast(context, 'Cần nhập lý do hủy.', error: true);
      return;
    }
    final done = await runWithToast(context, () => ref.read(financeActionsProvider).voidExpense(expense.id, text), success: 'Đã hủy khoản chi.');
    if (done && context.mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final e = expense;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(money(e.amount), style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          _row(context, 'Ngày', e.date),
          _row(context, 'Nhóm', e.category),
          _row(context, 'Chi cho', e.payee),
          _row(context, 'Số chứng từ', e.docNo),
          _row(context, 'Ghi chú', e.note),
          _row(context, 'Nguồn', e.fromPurchase ? 'Phiếu nhập ${e.purchaseCode ?? ''}' : 'Chi tay'),
          if (e.vatIncluded) _row(context, 'VAT', 'Đã gồm VAT đầu vào'),
          if (e.isVoid) _row(context, 'Đã hủy', e.voidReason ?? ''),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (e.hasReceipt)
              OutlinedButton.icon(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReceiptViewer(expenseId: e.id))),
                icon: const Icon(Icons.photo_rounded),
                label: const Text('Xem ảnh chứng từ'),
              ),
            if (!e.isVoid)
              OutlinedButton.icon(
                onPressed: () async {
                  Navigator.pop(context);
                  await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => ExpenseFormScreen(expense: e)));
                },
                icon: const Icon(Icons.edit_rounded),
                label: const Text('Sửa'),
              ),
            if (!e.isVoid && !e.fromPurchase)
              OutlinedButton.icon(
                onPressed: () => _void(context, ref),
                icon: Icon(Icons.block_rounded, color: context.co.bad),
                label: Text('Hủy khoản chi', style: TextStyle(color: context.co.bad)),
              ),
          ]),
        ]),
      ),
    );
  }
}
