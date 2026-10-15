import 'package:flutter/material.dart';
import '../../core/offline/offline_writer.dart';
import '../../core/offline/offline_effects.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../customers/customer_providers.dart' show customersPageProvider;
import '../menu/form_sheet.dart' show showFormSheet;
import 'order_widgets.dart';
import 'orders_models.dart';
import 'orders_providers.dart';
import 'pay_sheet.dart';
import 'record_debt_sheet.dart';

/// Content width from which items and the info column sit side by side (the web's lg 8/4 grid).
const _kTwoColumns = 900.0;

Color _strong(BuildContext c) => Theme.of(c).brightness == Brightness.light ? Palette.navyDarker : c.cs.onSurface;
Color _link(BuildContext c) => Theme.of(c).brightness == Brightness.light ? Palette.navyAccent : c.cs.primary;

/// Chi tiết đơn (views/pages/order_detail.ejs): header, KPIs, items with totals, info, pay, other actions.
class OrderDetailScreen extends ConsumerWidget {
  const OrderDetailScreen({super.key, required this.id});
  final int id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(orderDetailProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Chi tiết đơn')),
      body: AsyncBody<OrderDetail>(
        value: async,
        onRetry: () => ref.invalidate(orderDetailProvider(id)),
        data: (o) => _DetailBody(order: o),
      ),
    );
  }
}

class _DetailBody extends ConsumerWidget {
  const _DetailBody({required this.order});
  final OrderDetail order;

  void _reload(WidgetRef ref) {
    ref.invalidate(orderDetailProvider(order.id));
    ref.invalidate(ordersPageProvider);
  }

  Future<void> _pay(BuildContext context, WidgetRef ref, bool isAdmin) async {
    final r = await showPaySheet(context, order: order, isAdmin: isAdmin);
    if (r == null || !context.mounted) return;
    _reload(ref);
    showToast(context, 'Đã ghi nhận thanh toán đơn ${r.orderCode}.${r.change > 0 ? ' Thối ${money(r.change)}.' : ''}');
  }

  /// "Ghi công nợ": puts this Zalo order on a customer's debt (existing or new), then the customer is told on Zalo.
  Future<void> _recordDebt(BuildContext context, WidgetRef ref) async {
    final res = await showFormSheet<Map<String, dynamic>>(context, builder: (_) => RecordDebtSheet(order: order));
    if (res == null || !context.mounted) return;
    _reload(ref);
    ref.invalidate(customersPageProvider);
    showToast(context, recordDebtMessage(res, order.orderCode));
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => _ConfirmSheet(
        title: 'Hủy đơn',
        message: 'Hủy đơn ${order.orderCode}? Đơn chưa trừ kho nên không ảnh hưởng tồn kho.',
        confirm: 'Hủy đơn',
      ),
    );
    if (ok != true || !context.mounted) return;
    final done = await runWithToast(context, () async {
      try {
        await ref.read(offlineWriterProvider).submit(
              kind: 'order.cancel',
              path: '/orders/${order.id}/cancel',
              body: const {},
              local: {'code': order.orderCode},
              effect: (db) async => {'order': await db.cancelOrderLocally(order.id)},
            );
      } catch (e) {
        throw orderError(e);
      }
    }, success: 'Đã hủy đơn ${order.orderCode}.');
    if (done && context.mounted) _reload(ref);
  }

  Future<void> _resend(BuildContext context, WidgetRef ref) async {
    final api = ref.read(apiProvider);
    await runWithToast(context, () async {
      Map<String, dynamic> r;
      try {
        r = await api.post('/orders/${order.id}/resend-receipt');
      } catch (e) {
        throw orderError(e);
      }
      // A Zalo delivery failure is a 200 with { sent: false, error }.
      if (r['sent'] != true) {
        throw ApiException(code: 'ZALO_FAILED', message: 'Gửi bill thất bại: ${r['error'] ?? 'không rõ lỗi'}');
      }
    }, success: 'Đã gửi lại bill ${order.orderCode} qua Zalo.');
    if (context.mounted) _reload(ref); // receipt_sent_at / receipt_error changed either way
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final o = order;
    final isAdmin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    // Cost and profit are admin data (the web page is admin-only; the API strips cogs for cashiers).
    final showCosts = isAdmin && o.cogsTotal != null;
    // Settling a customer's debt on a delivered Zalo order is admin-only (security_prereqs #4).
    final canPay = o.canPay && (isAdmin || !(o.isComplete && o.customerId != null));
    final canCancel = o.canCancel && isAdmin;

    final info = _InfoCard(order: o, isAdmin: isAdmin);
    final side = <Widget>[
      info,
      if (canPay) ...[
        const SizedBox(height: 16),
        PanelCard(
          key: const Key('pay-card'),
          title: 'Thu tiền',
          icon: Icons.receipt_outlined,
          amber: true,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text(
                o.isOpen ? 'Thu tiền sẽ hoàn tất đơn: trừ kho theo định mức và chốt giá vốn.' : 'Đơn Zalo đã trừ kho; chỉ ghi nhận tiền đã thu.',
                style: TextStyle(fontSize: 13, color: context.co.warn),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                key: const Key('open-pay'),
                onPressed: () => _pay(context, ref, isAdmin),
                icon: const Icon(Icons.check_rounded),
                label: Text(o.isOpen ? 'Thu tiền & hoàn tất đơn' : 'Thu ${money(o.total)}'),
              ),
            ]),
          ),
        ),
      ],
      if (isAdmin && o.canRecordDebt) ...[
        const SizedBox(height: 16),
        PanelCard(
          key: const Key('debt-card'),
          title: 'Công nợ',
          icon: Icons.account_balance_wallet_outlined,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Đơn Zalo này chưa nằm trong sổ nợ của khách nào. Ghi nợ sẽ gắn đơn vào khách, tăng số dư nợ và báo khách qua Zalo.',
                  style: context.tt.bodySmall),
              const SizedBox(height: 12),
              FilledButton.icon(
                key: const Key('open-record-debt'),
                onPressed: () => _recordDebt(context, ref),
                icon: const Icon(Icons.receipt_long_rounded),
                label: const Text('Ghi công nợ cho khách'),
              ),
            ]),
          ),
        ),
      ],
      if (o.canResend || canCancel) ...[
        const SizedBox(height: 16),
        PanelCard(
          title: 'Thao tác khác',
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (o.canResend)
                OutlinedButton.icon(
                  onPressed: () => _resend(context, ref),
                  icon: const Icon(Icons.chat_bubble_outline_rounded, size: 20),
                  label: const Text('Gửi lại bill qua Zalo'),
                ),
              if (o.canResend && canCancel) const SizedBox(height: 10),
              if (canCancel)
                FilledButton.icon(
                  onPressed: () => _cancel(context, ref),
                  style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626), foregroundColor: Colors.white),
                  icon: const Icon(Icons.close_rounded, size: 20),
                  label: const Text('Hủy đơn'),
                ),
            ]),
          ),
        ),
      ],
    ];

    return RefreshIndicator(
      onRefresh: () async {
        final next = ref.refresh(orderDetailProvider(o.id).future);
        try {
          await next;
        } catch (_) {}
      },
      child: LayoutBuilder(builder: (context, c) {
        final two = c.maxWidth >= _kTwoColumns;
        final items = _ItemsCard(order: o, showCosts: showCosts);
        return ListView(
          key: const Key('order-detail-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            _Header(order: o),
            const SizedBox(height: 6),
            _MetaLine(order: o, isAdmin: isAdmin),
            const SizedBox(height: 16),
            _Kpis(order: o, showCosts: showCosts, width: c.maxWidth - 32),
            const SizedBox(height: 20),
            if (two)
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(flex: 8, child: items),
                const SizedBox(width: 20),
                Expanded(flex: 4, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: side)),
              ])
            else ...[
              items,
              const SizedBox(height: 16),
              ...side,
            ],
          ],
        );
      }),
    );
  }
}

class _Header extends ConsumerWidget {
  const _Header({required this.order});
  final OrderDetail order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final o = order;
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      crossAxisAlignment: WrapCrossAlignment.center,
      alignment: WrapAlignment.spaceBetween,
      children: [
        Wrap(spacing: 10, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text(o.orderCode, style: TextStyle(fontFamily: kMono, fontSize: 21, fontWeight: FontWeight.w700, color: _strong(context))),
          OrderStatusBadge(status: o.status, paymentStatus: o.paymentStatus),
          SourceBadge(source: o.source),
        ]),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (o.isOpen)
            OutlinedButton.icon(
              key: const Key('open-pos'),
              onPressed: () => context.push('/pos?order=${o.id}'),
              icon: const Icon(Icons.point_of_sale_rounded, size: 19),
              label: const Text('Mở trên POS'),
            ),
          if (o.printable)
            OutlinedButton.icon(
              onPressed: () => openReceipt(context, ref, o.id),
              icon: const Icon(Icons.receipt_outlined, size: 19),
              label: const Text('In hóa đơn'),
            ),
        ]),
      ],
    );
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.order, required this.isAdmin});
  final OrderDetail order;
  final bool isAdmin;

  @override
  Widget build(BuildContext context) {
    final o = order;
    final muted = TextStyle(color: context.co.muted, fontSize: 14);
    final dot = Text(' · ', style: muted);
    final parts = <Widget>[
      Text('Tạo lúc ${shopTime(o.createdAt)}', style: muted.copyWith(fontFeatures: tabular)),
      if (o.tableName != null) ...[
        dot,
        Text(o.tableName!, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: context.cs.onSurface)),
      ],
      if (o.customerId != null) ...[dot, _CustomerLink(order: o, isAdmin: isAdmin, fontSize: 14)],
      if (o.completedAt != null) ...[dot, Text('hoàn tất ${shopTime(o.completedAt)}', style: muted.copyWith(fontFeatures: tabular))],
    ];
    return Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: parts);
  }
}

/// Customer name linking to /customers/:id (admin only; that module is admin-only in the router).
class _CustomerLink extends StatelessWidget {
  const _CustomerLink({required this.order, required this.isAdmin, this.fontSize = 14.5});
  final OrderDetail order;
  final bool isAdmin;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final name = order.customerName ?? 'Khách #${order.customerId}';
    if (!isAdmin) return Text(name, style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.w600));
    return InkWell(
      onTap: () => context.push('/customers/${order.customerId}'),
      child: Text(name, style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.w600, color: _link(context))),
    );
  }
}

class _Kpis extends StatelessWidget {
  const _Kpis({required this.order, required this.showCosts, required this.width});
  final OrderDetail order;
  final bool showCosts;
  final double width;

  @override
  Widget build(BuildContext context) {
    final o = order;
    final cols = width >= 600 ? 4 : 2;
    final tiles = <Widget>[
      _Kpi(label: 'Tổng cộng', value: money(o.total), color: _strong(context)),
      _Kpi(label: 'Tạm tính', value: money(o.subtotal)),
      _Kpi(label: 'Giảm giá', value: o.discount > 0 ? '−${money(o.discount)}' : '—'),
      if (o.isComplete && showCosts)
        _Kpi(label: 'Lãi gộp', value: money(o.profit), sub: pct(o.margin), color: marginTone(o.margin).fg(context))
      else
        _Kpi(label: 'Thanh toán', value: o.isPaid ? methodLabel(o.paymentMethod) : 'Chưa thu'),
    ];
    // Rows of equal-height tiles, like the web's CSS grid.
    return Column(children: [
      for (var r = 0; r < tiles.length; r += cols) ...[
        if (r > 0) const SizedBox(height: 12),
        IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = r; i < r + cols && i < tiles.length; i++) ...[
              if (i > r) const SizedBox(width: 12),
              Expanded(child: tiles[i]),
            ],
          ]),
        ),
      ],
    ]);
  }
}

class _Kpi extends StatelessWidget {
  const _Kpi({required this.label, required this.value, this.sub, this.color});
  final String label;
  final String value;
  final String? sub;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label.toUpperCase(), style: context.tt.labelSmall?.copyWith(fontSize: 11)),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value,
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, fontFeatures: tabular, color: color ?? context.cs.onSurface)),
          ),
          if (sub != null) Text(sub!, style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
        ]),
      ),
    );
  }
}

class _ItemsCard extends StatelessWidget {
  const _ItemsCard({required this.order, required this.showCosts});
  final OrderDetail order;
  final bool showCosts;

  @override
  Widget build(BuildContext context) {
    final o = order;
    return PanelCard(
      title: 'Món đã gọi (${o.items.length})',
      child: LayoutBuilder(builder: (context, c) {
        final table = c.maxWidth >= 520;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (o.items.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Column(children: [
                Icon(Icons.local_cafe_outlined, size: 32, color: context.co.line),
                const SizedBox(height: 8),
                Text('Đơn chưa có món.', style: TextStyle(color: context.co.muted)),
              ]),
            )
          else if (table) ...[
            Container(
              color: context.cs.surfaceContainerLow,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(children: [
                Expanded(flex: 5, child: Text('MÓN', style: context.tt.labelSmall)),
                Expanded(flex: 1, child: Text('SL', textAlign: TextAlign.right, style: context.tt.labelSmall)),
                Expanded(flex: 2, child: Text('ĐƠN GIÁ', textAlign: TextAlign.right, style: context.tt.labelSmall)),
                Expanded(flex: 2, child: Text('THÀNH TIỀN', textAlign: TextAlign.right, style: context.tt.labelSmall)),
              ]),
            ),
            for (final i in o.items)
              Container(
                decoration: BoxDecoration(border: Border(top: BorderSide(color: context.co.line))),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                child: Row(children: [
                  Expanded(flex: 5, child: _ItemName(item: i)),
                  Expanded(flex: 1, child: Text(qty(i.quantity), textAlign: TextAlign.right, style: const TextStyle(fontFeatures: tabular))),
                  Expanded(
                    flex: 2,
                    child: Text(money(i.unitPrice),
                        textAlign: TextAlign.right, style: TextStyle(color: context.co.muted, fontFeatures: tabular)),
                  ),
                  Expanded(
                    flex: 2,
                    child: Text(money(i.lineTotal),
                        textAlign: TextAlign.right,
                        style: TextStyle(fontWeight: FontWeight.w700, color: _strong(context), fontFeatures: tabular)),
                  ),
                ]),
              ),
          ] else
            for (final (n, i) in o.items.indexed)
              Container(
                decoration: n == 0 ? null : BoxDecoration(border: Border(top: BorderSide(color: context.co.line))),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  _ItemName(item: i),
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(child: _Mini(label: 'SL', value: qty(i.quantity))),
                    Expanded(flex: 2, child: _Mini(label: 'Đơn giá', value: money(i.unitPrice), end: true)),
                    Expanded(flex: 2, child: _Mini(label: 'Thành tiền', value: money(i.lineTotal), end: true, strong: true)),
                  ]),
                ]),
              ),
          Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: context.co.line))),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
            child: Column(children: [
              _TotalRow(label: 'Tạm tính', value: money(o.subtotal), color: context.co.muted),
              if (o.discount > 0) _TotalRow(label: 'Giảm giá', value: '−${money(o.discount)}', color: context.co.warn),
              const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: DashedDivider()),
              _TotalRow(label: 'Tổng cộng', value: money(o.total), color: _strong(context), bold: true),
              if (o.isComplete && showCosts) ...[
                _TotalRow(label: 'Giá vốn (COGS)', value: money(o.cogsTotal), color: context.co.muted),
                _TotalRow(
                  label: 'Lãi gộp',
                  value: '${money(o.profit)}${o.total > 0 ? ' (${pct(o.margin)})' : ''}',
                  color: o.margin >= 55 ? context.co.good : context.co.bad,
                ),
              ],
            ]),
          ),
        ]);
      }),
    );
  }
}

class _ItemName extends StatelessWidget {
  const _ItemName({required this.item});
  final OrderItem item;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(item.productName, style: const TextStyle(fontWeight: FontWeight.w600)),
      if (item.note != null)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text('📝 ${item.note}', style: context.tt.bodySmall),
        ),
    ]);
  }
}

class _Mini extends StatelessWidget {
  const _Mini({required this.label, required this.value, this.end = false, this.strong = false});
  final String label;
  final String value;
  final bool end;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: end ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
      Text(label.toUpperCase(), style: context.tt.labelSmall?.copyWith(fontSize: 10.5)),
      const SizedBox(height: 2),
      Text(value,
          style: TextStyle(
              fontFeatures: tabular,
              fontWeight: strong ? FontWeight.w700 : FontWeight.w400,
              color: strong ? _strong(context) : (end ? context.co.muted : context.cs.onSurface))),
    ]);
  }
}

class _TotalRow extends StatelessWidget {
  const _TotalRow({required this.label, required this.value, required this.color, this.bold = false});
  final String label;
  final String value;
  final Color color;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(color: color, fontSize: bold ? 16.5 : 14.5, fontWeight: bold ? FontWeight.w700 : FontWeight.w400);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        Expanded(child: Text(label, style: style)),
        Text(value, style: style.copyWith(fontFeatures: tabular)),
      ]),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.order, required this.isAdmin});
  final OrderDetail order;
  final bool isAdmin;

  @override
  Widget build(BuildContext context) {
    final o = order;
    final rows = <Widget>[
      _InfoRow(label: 'Trạng thái', child: OrderStatusBadge(status: o.status, paymentStatus: o.paymentStatus)),
      _InfoRow(label: 'Kênh', child: SourceBadge(source: o.source)),
      _InfoRow(
        label: 'Thanh toán',
        child: o.isPaid ? StatusBadge(methodLabel(o.paymentMethod), tone: Tone.good) : const StatusBadge('Chưa thu', tone: Tone.warn),
      ),
      if (o.paidAt != null) _InfoRow(label: 'Thu lúc', child: Text(shopTime(o.paidAt), style: const TextStyle(fontFeatures: tabular))),
      if (o.tableName != null) _InfoRow(label: 'Bàn', child: Text(o.tableName!, style: const TextStyle(fontWeight: FontWeight.w600))),
      if (o.customerId != null) _InfoRow(label: 'Khách hàng', child: _CustomerLink(order: o, isAdmin: isAdmin)),
      if (o.note != null) _InfoRow(label: 'Ghi chú', child: Text(o.note!, textAlign: TextAlign.right)),
      if (o.source == 'zalo') ...[
        _InfoRow(label: 'Zalo', child: Text(o.zaloChatType == 'group' ? 'Nhóm chat' : 'Chat 1:1')),
        _InfoRow(
          label: 'Bill Zalo',
          child: o.receiptSentAt != null
              ? StatusBadge('Đã gửi ${shopTime(o.receiptSentAt)}', tone: Tone.good)
              : (o.receiptError != null
                  ? const StatusBadge('Gửi lỗi', tone: Tone.bad)
                  : const StatusBadge('Chưa gửi', tone: Tone.neutral)),
        ),
      ],
    ];
    return PanelCard(
      title: 'Thông tin',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, r) in rows.indexed) ...[if (i > 0) Divider(color: context.co.neutralTint), r],
        if (o.source == 'zalo' && o.receiptError != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: context.co.badTint,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: context.co.bad.withValues(alpha: 0.25)),
              ),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(Icons.close_rounded, size: 15, color: context.co.bad),
                const SizedBox(width: 4),
                Expanded(child: Text(o.receiptError!, style: TextStyle(fontSize: 12.5, color: context.co.bad))),
              ]),
            ),
          ),
        if (o.payments.isNotEmpty)
          Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: context.co.line))),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('LỊCH SỬ THU TIỀN', style: context.tt.labelSmall),
              const SizedBox(height: 8),
              for (final p in o.payments)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(methodLabel(p.method), style: const TextStyle(fontWeight: FontWeight.w600)),
                        Text(
                          [shopTime(p.paidAt), ?p.receivedByName, ?p.reference].join(' · '),
                          style: context.tt.bodySmall?.copyWith(fontFeatures: tabular),
                        ),
                      ]),
                    ),
                    const SizedBox(width: 12),
                    Text(money(p.amount), style: TextStyle(fontWeight: FontWeight.w700, color: _strong(context), fontFeatures: tabular)),
                  ]),
                ),
            ]),
          ),
      ]),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      child: Row(children: [
        Text(label, style: TextStyle(color: context.co.muted)),
        const SizedBox(width: 12),
        Expanded(child: Align(alignment: Alignment.centerRight, child: child)),
      ]),
    );
  }
}

/// Confirm dialog as a bottom sheet (the web's data-confirm).
class _ConfirmSheet extends StatelessWidget {
  const _ConfirmSheet({required this.title, required this.message, required this.confirm});
  final String title;
  final String message;
  final String confirm;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: context.tt.titleLarge),
          const SizedBox(height: 8),
          Text(message, style: context.tt.bodyMedium),
          const SizedBox(height: 20),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context, false), child: const Text('Không'))),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                key: const Key('confirm-yes'),
                onPressed: () => Navigator.pop(context, true),
                style: FilledButton.styleFrom(backgroundColor: const Color(0xFFDC2626), foregroundColor: Colors.white),
                child: Text(confirm),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}
