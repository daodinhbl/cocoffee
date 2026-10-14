import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'customer_form_screen.dart';
import 'customer_models.dart';
import 'customer_providers.dart';
import 'customer_widgets.dart';

const _amber300 = Color(0xFFFCD34D);

/// Chi tiết khách hàng (views/pages/customer_detail.ejs): header, balance hero, Thu nợ / Điều chỉnh (sheets on
/// phones, dialogs on tablets), Sổ công nợ with the running balance, Đơn hàng của khách.
class CustomerDetailScreen extends ConsumerStatefulWidget {
  const CustomerDetailScreen({super.key, required this.id});
  final int id;

  @override
  ConsumerState<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _Flash {
  const _Flash(this.message, [this.settled = const []]);
  final String message;
  final List<String> settled;
}

class _CustomerDetailScreenState extends ConsumerState<CustomerDetailScreen> {
  _Flash? _flash;

  Future<void> _collect(Customer c) async {
    final res = await showFormSheet<Map<String, dynamic>>(context, builder: (_) => _CollectSheet(customer: c));
    if (res == null || !mounted) return;
    // Same sentence as the web flash: 'Đã thu {amount}đ. Còn nợ {balance}đ. Đã tất toán N đơn: codes.'
    setState(() => _flash = _Flash('Đã thu ${money(parseNum(res['amount']))}. Còn nợ ${money(parseNum(res['balance']))}.',
        parseStrings(res['settled'])));
    invalidateCustomerData(ref, id: widget.id);
  }

  Future<void> _adjust(Customer c) async {
    final res = await showFormSheet<Map<String, dynamic>>(context, builder: (_) => AdjustSheet(customer: c));
    if (res == null || !mounted) return;
    setState(() => _flash = _Flash(adjustMessage(parseNum(res['balance']), res['notify'])));
    invalidateCustomerData(ref, id: widget.id);
  }

  /// The form toasts 'Đã cập nhật thông tin khách hàng.' and invalidates this customer, so the page reloads itself.
  Future<void> _edit(Customer c) =>
      Navigator.of(context).push<Customer>(MaterialPageRoute(builder: (_) => CustomerFormScreen(customer: c)));

  Future<void> _refresh() async {
    try {
      ref.invalidate(customerDetailProvider(widget.id));
      await ref.read(customerDetailProvider(widget.id).future);
    } catch (_) {
      // shown by AsyncBody
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(customerDetailProvider(widget.id));
    final d = async.value;
    final wide = isWide(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(d?.customer.name ?? 'Khách hàng', overflow: TextOverflow.ellipsis),
        actions: d == null
            ? const []
            : [
                if (wide) ...[
                  TextButton.icon(
                    onPressed: () => openStatement(context, ref, d.customer.id),
                    icon: const Icon(Icons.receipt_long_outlined),
                    label: const Text('Biên bản đối chiếu'),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(right: 12),
                    child: TextButton.icon(onPressed: () => _edit(d.customer), icon: const Icon(Icons.edit_outlined), label: const Text('Sửa')),
                  ),
                ] else ...[
                  IconButton(
                    tooltip: 'Biên bản đối chiếu',
                    onPressed: () => openStatement(context, ref, d.customer.id),
                    icon: const Icon(Icons.receipt_long_outlined),
                  ),
                  IconButton(tooltip: 'Sửa', onPressed: () => _edit(d.customer), icon: const Icon(Icons.edit_outlined)),
                ],
              ],
      ),
      body: AsyncBody<CustomerDetail>(
        value: async,
        onRetry: () => ref.invalidate(customerDetailProvider(widget.id)),
        data: (d) {
          final c = d.customer;
          final flash = _flash == null
              ? null
              : Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: FlashBanner(
                    message: _flash!.message,
                    onClose: () => setState(() => _flash = null),
                    extra: _flash!.settled.isEmpty
                        ? null
                        : Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                            Text('Đã tất toán ${_flash!.settled.length} đơn:', style: TextStyle(color: context.co.good)),
                            for (final code in _flash!.settled) StatusBadge(code, tone: Tone.good, dense: true),
                          ]),
                  ),
                );
          final header = _Header(customer: c);
          final hero = _BalanceHero(detail: d);
          final actions = _DebtActions(owes: c.owes, onCollect: () => _collect(c), onAdjust: () => _adjust(c));
          final ledger = _LedgerCard(detail: d);
          final orders = _OrdersCard(orders: d.orders, wide: wide);

          if (wide) {
            return RefreshIndicator(
              onRefresh: _refresh,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  ?flash,
                  header,
                  const SizedBox(height: 20),
                  Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Expanded(
                      flex: 5,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [hero, const SizedBox(height: 16), actions]),
                    ),
                    const SizedBox(width: 24),
                    Expanded(
                      flex: 7,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [ledger, const SizedBox(height: 20), orders]),
                    ),
                  ]),
                ]),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
              children: [
                ?flash,
                header,
                const SizedBox(height: 18),
                hero,
                const SizedBox(height: 14),
                actions,
                const SizedBox(height: 18),
                ledger,
                const SizedBox(height: 16),
                orders,
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.customer});
  final Customer customer;

  @override
  Widget build(BuildContext context) {
    final c = customer;
    return Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
      Container(
        width: 56,
        height: 56,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Palette.navy, borderRadius: BorderRadius.circular(14)),
        child: Text(c.initials, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18)),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(c.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w600, color: Palette.navyDarker)),
          const SizedBox(height: 4),
          Wrap(spacing: 12, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (c.phone != null)
              InkWell(
                onTap: () => callPhone(context, c.phone!),
                child: Text(c.phone!, style: TextStyle(fontFeatures: tabular, color: context.cs.onSurface, fontSize: 14)),
              ),
            if (c.hasZalo) const ZaloBadge(),
            Text('Khách từ ${shopTime(c.createdAt)}', style: context.tt.bodySmall?.copyWith(fontSize: 13.5)),
          ]),
          if (c.note != null) ...[
            const SizedBox(height: 4),
            Text(c.note!, style: context.tt.bodySmall?.copyWith(fontStyle: FontStyle.italic, fontSize: 13.5)),
          ],
        ]),
      ),
    ]);
  }
}

class _BalanceHero extends StatelessWidget {
  const _BalanceHero({required this.detail});
  final CustomerDetail detail;

  @override
  Widget build(BuildContext context) {
    final d = detail;
    final balance = d.customer.balance;
    final owes = balance > 0;
    final labelColor = owes ? Palette.navyMuted : context.co.muted;
    final sub = owes
        ? '${d.unpaid.length} đơn chưa thu · ${money(d.unpaidTotal)}'
        : balance < 0
            ? 'Khách đang có tiền trả trước'
            : 'Không còn nợ';
    Widget stat(String label, num v) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(color: labelColor, fontSize: 13.5)),
          Text(money(v),
              style: TextStyle(
                  fontFeatures: tabular, fontWeight: FontWeight.w600, fontSize: 15, color: owes ? Colors.white : context.cs.onSurface)),
        ]);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: owes ? Palette.navyDarker : context.cs.surface,
        borderRadius: BorderRadius.circular(14),
        border: owes ? null : Border.all(color: context.co.line),
        boxShadow: const [BoxShadow(color: Color(0x400F172A), offset: Offset(0, 12), blurRadius: 32, spreadRadius: -16)],
      ),
      child: Stack(children: [
        if (owes)
          Positioned(
            right: -48,
            top: -48,
            child: Container(
              width: 160,
              height: 160,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [Palette.amber.withValues(alpha: 0.22), Palette.amber.withValues(alpha: 0)]),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('SỐ DƯ CÔNG NỢ', style: TextStyle(color: labelColor, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 1)),
            const SizedBox(height: 4),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(money(balance),
                  style: TextStyle(
                    fontFeatures: tabular,
                    fontWeight: FontWeight.w700,
                    fontSize: 36,
                    height: 1.15,
                    color: owes ? _amber300 : balance < 0 ? context.co.good : Palette.navyDarker,
                  )),
            ),
            const SizedBox(height: 4),
            Text(sub, style: TextStyle(color: owes ? Palette.navySoft : context.co.muted, fontSize: 14)),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: stat('Tổng phát sinh', d.debtTotal)),
              const SizedBox(width: 12),
              Expanded(child: stat('Đã thu', d.paidTotal)),
            ]),
          ]),
        ),
      ]),
    );
  }
}

class _DebtActions extends StatelessWidget {
  const _DebtActions({required this.owes, required this.onCollect, required this.onAdjust});
  final bool owes;
  final VoidCallback onCollect;
  final VoidCallback onAdjust;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (owes) ...[
        FilledButton.icon(onPressed: onCollect, icon: const Icon(Icons.payments_outlined), label: const Text('Thu nợ')),
        const SizedBox(height: 10),
      ],
      OutlinedButton.icon(onPressed: onAdjust, icon: const Icon(Icons.tune_rounded), label: const Text('Điều chỉnh công nợ thủ công')),
    ]);
  }
}

class _LedgerCard extends StatelessWidget {
  const _LedgerCard({required this.detail});
  final CustomerDetail detail;

  @override
  Widget build(BuildContext context) {
    return ListSectionCard(
      title: 'Sổ công nợ',
      count: '${detail.ledger.length} dòng',
      emptyText: 'Chưa có phát sinh công nợ.',
      children: [for (final l in detail.ledger) _LedgerRow(entry: l)],
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.entry});
  final LedgerEntry entry;

  @override
  Widget build(BuildContext context) {
    final l = entry;
    final (label, tone) = entryLabels[l.entryType] ?? (l.entryType, Tone.neutral);
    final meta = [shopTime(l.createdAt), ?l.createdByName, ?l.visibleNote].join(' · ');
    final plus = l.increases;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              StatusBadge(label, tone: tone, dense: true),
              if (l.orderCode != null) LinkText(l.orderCode!, size: 13.5, onTap: () => openOrder(context, l.orderId)),
              if (l.method != null) Text(methodLabels[l.method] ?? l.method!, style: context.tt.bodySmall),
            ]),
            const SizedBox(height: 4),
            Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall),
          ]),
        ),
        const SizedBox(width: 12),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('${plus ? '+' : '−'}${money(l.amount.abs())}',
              style: TextStyle(fontFeatures: tabular, fontWeight: FontWeight.w600, color: plus ? context.co.bad : context.co.good)),
          Text('Dư ${money(l.after)}', style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
        ]),
      ]),
    );
  }
}

class _OrdersCard extends StatelessWidget {
  const _OrdersCard({required this.orders, required this.wide});
  final List<CustomerOrder> orders;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    return ListSectionCard(
      title: 'Đơn hàng của khách',
      count: '${orders.length} đơn',
      emptyText: 'Chưa có đơn nào liên kết với khách này.',
      children: [for (final o in orders) _orderRow(context, o)],
    );
  }

  Widget _orderRow(BuildContext context, CustomerOrder o) {
    final (label, tone) = orderStatusOf(o.status, o.paymentStatus);
    final status = StatusBadge(label, tone: tone, dense: true);
    final total = Text(money(o.total),
        textAlign: TextAlign.right,
        style: const TextStyle(fontFeatures: tabular, fontWeight: FontWeight.w600, color: Palette.navyDarker));
    final source = o.source == 'zalo' ? const StatusBadge('Zalo', tone: Tone.info, dense: true) : const StatusBadge('POS', dense: true);
    return InkWell(
      onTap: () => openOrder(context, o.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                LinkText(o.orderCode, bold: true, size: 13.5),
                source,
              ]),
              const SizedBox(height: 2),
              Text(shopTime(o.createdAt), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
            ]),
          ),
          const SizedBox(width: 12),
          if (wide) ...[
            status,
            const SizedBox(width: 12),
            SizedBox(width: 104, child: total),
          ] else
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [total, const SizedBox(height: 4), status]),
        ]),
      ),
    );
  }
}

String _plainNumber(num v) => v == v.roundToDouble() ? '${v.round()}' : v.toStringAsFixed(2);
num _jsonNumber(num v) => v == v.roundToDouble() ? v.round() : v;

/// 'Thu nợ' form (amount defaults to the whole balance, 'Thu hết' shortcut, method, note). POST collect.
class _CollectSheet extends ConsumerStatefulWidget {
  const _CollectSheet({required this.customer});
  final Customer customer;

  @override
  ConsumerState<_CollectSheet> createState() => _CollectSheetState();
}

class _CollectSheetState extends ConsumerState<_CollectSheet> {
  final _form = GlobalKey<FormState>();
  late final _amount = TextEditingController(text: _plainNumber(widget.customer.balance));
  final _note = TextEditingController();
  String _method = 'cash';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final c = widget.customer;
    if (!await confirmAction(context, 'Ghi nhận thu nợ của ${c.name}?') || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final note = _note.text.trim();
      final res = await ref.read(apiProvider).post('/admin/customers/${c.id}/collect', {
        'amount': _jsonNumber(num.parse(_amount.text.trim())),
        'method': _method,
        if (note.isNotEmpty) 'note': note,
      });
      if (mounted) Navigator.of(context).pop(res);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.customer;
    return Form(
      key: _form,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Thu nợ', style: context.tt.titleLarge),
        const SizedBox(height: 2),
        Text('${c.name} · Số dư ${money(c.balance)}', style: context.tt.bodySmall?.copyWith(fontSize: 13.5)),
        const SizedBox(height: 16),
        if (_error != null) ...[InlineError(_error!), const SizedBox(height: 12)],
        FieldLabel(
          'Số tiền thu (đ)',
          hint: 'Có thể thu một phần. Tiền thu được trừ vào các đơn nợ cũ nhất trước; đơn nào được trả đủ sẽ chuyển "Đã thu".',
          child: TextFormField(
            key: const ValueKey('collect-amount'),
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textAlign: TextAlign.right,
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            style: const TextStyle(fontFeatures: tabular, fontSize: 20, fontWeight: FontWeight.w600),
            decoration: InputDecoration(
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: TextButton(
                  onPressed: () => setState(() => _amount.text = _plainNumber(c.balance)),
                  child: const Text('Thu hết'),
                ),
              ),
            ),
            validator: (v) {
              final n = num.tryParse((v ?? '').trim());
              if (n == null || n < 1) return 'Nhập số tiền thu (tối thiểu 1đ).';
              if (n > c.balance) return 'Số tiền thu lớn hơn số nợ hiện tại (${money(c.balance)}).';
              return null;
            },
          ),
        ),
        const SizedBox(height: 14),
        FieldLabel(
          'Hình thức',
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            for (final m in methodLabels.entries)
              ChoiceChip(
                label: Text(m.value),
                selected: _method == m.key,
                onSelected: (_) => setState(() => _method = m.key),
              ),
          ]),
        ),
        const SizedBox(height: 14),
        FieldLabel(
          'Ghi chú',
          child: TextFormField(
            key: const ValueKey('collect-note'),
            controller: _note,
            inputFormatters: [LengthLimitingTextInputFormatter(255)],
            decoration: const InputDecoration(hintText: 'VD: CK Vietcombank'),
          ),
        ),
        const SizedBox(height: 18),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
              : const Text('Ghi nhận thu nợ'),
        ),
      ]),
    );
  }
}

/// 'Điều chỉnh công nợ thủ công': Tăng nợ (+) / Giảm nợ (−), amount, required reason. POST adjust.
/// [increaseOnly]: the list's 'Ghi nợ' button (the web's debt-add-dialog): only adds debt, no direction choice.
class AdjustSheet extends ConsumerStatefulWidget {
  const AdjustSheet({super.key, required this.customer, this.increaseOnly = false});
  final Customer customer;
  final bool increaseOnly;

  @override
  ConsumerState<AdjustSheet> createState() => _AdjustSheetState();
}

class _AdjustSheetState extends ConsumerState<AdjustSheet> {
  final _form = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _note = TextEditingController();
  String _direction = 'increase';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final c = widget.customer;
    final ask = widget.increaseOnly ? 'Ghi nợ ${money(num.parse(_amount.text.trim()))} cho ${c.name}?' : 'Điều chỉnh công nợ của ${c.name}?';
    if (!await confirmAction(context, ask) || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiProvider).post('/admin/customers/${c.id}/adjust', {
        'amount': _jsonNumber(num.parse(_amount.text.trim())),
        'direction': _direction,
        'note': _note.text.trim(),
      });
      if (mounted) Navigator.of(context).pop(res);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.customer;
    return Form(
      key: _form,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(widget.increaseOnly ? 'Ghi nợ cho khách' : 'Điều chỉnh công nợ thủ công', style: context.tt.titleLarge),
        const SizedBox(height: 2),
        Text('${c.name} · Số dư ${money(c.balance)}', style: context.tt.bodySmall?.copyWith(fontSize: 13.5)),
        const SizedBox(height: 16),
        if (_error != null) ...[InlineError(_error!), const SizedBox(height: 12)],
        if (!widget.increaseOnly) ...[
          FieldLabel(
            'Loại',
            child: SegmentedButton<String>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: 'increase', label: Text('Tăng nợ (+)')),
                ButtonSegment(value: 'decrease', label: Text('Giảm nợ (−)')),
              ],
              selected: {_direction},
              onSelectionChanged: (s) => setState(() => _direction = s.first),
            ),
          ),
          const SizedBox(height: 14),
        ],
        FieldLabel(
          'Số tiền (đ)',
          child: TextFormField(
            key: const ValueKey('adjust-amount'),
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            textAlign: TextAlign.right,
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            style: const TextStyle(fontFeatures: tabular, fontSize: 17, fontWeight: FontWeight.w600),
            validator: (v) {
              final n = num.tryParse((v ?? '').trim());
              if (n == null || n < 1) return 'Số tiền điều chỉnh phải khác 0.';
              if (n > 1e9) return 'Số tiền điều chỉnh quá lớn.';
              return null;
            },
          ),
        ),
        const SizedBox(height: 14),
        FieldLabel(
          'Lý do (bắt buộc)',
          child: TextFormField(
            key: const ValueKey('adjust-note'),
            controller: _note,
            inputFormatters: [LengthLimitingTextInputFormatter(255)],
            decoration: const InputDecoration(hintText: 'VD: nợ cũ ghi sổ tay, xóa nợ lẻ'),
            validator: (v) => (v ?? '').trim().isEmpty ? 'Ghi rõ lý do điều chỉnh.' : null,
          ),
        ),
        const SizedBox(height: 18),
        OutlinedButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
              : Text(widget.increaseOnly ? 'Ghi nợ' : 'Lưu điều chỉnh'),
        ),
      ]),
    );
  }
}
