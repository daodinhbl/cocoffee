import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/format.dart';
import '../../../core/session.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../pos_models.dart';
import '../pos_providers.dart';
import 'pos_dialogs.dart';
import 'pos_pay_sheet.dart';

/// Zalo inbox of the POS (web dialog 'Đơn Zalo chờ khách xác nhận' + UI spec 3.3). Tab 1: live drafts
/// (GET /api/zalo/drafts) with a read-only view of the items and 'Hủy'. Tab 2: orders the customer confirmed but
/// has not paid (GET /api/orders?source=zalo&status=completed&payment=unpaid) with 'Thu tiền' and 'Gửi lại'.
/// The draft itself is confirmed by the customer in Zalo ("ok"); the API has no confirm action for the POS.
class ZaloInbox extends ConsumerStatefulWidget {
  const ZaloInbox({super.key, this.scrollController, this.inSheet = false, this.onToast});
  final ScrollController? scrollController;
  final bool inSheet;

  /// The POS screen's toast (placed clear of the cart); defaults to the app toast.
  final void Function(String message, {bool error})? onToast;

  @override
  ConsumerState<ZaloInbox> createState() => _ZaloInboxState();
}

class _ZaloInboxState extends ConsumerState<ZaloInbox> {
  int _tab = 0;
  final _open = <int>{};

  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    final t = widget.onToast;
    if (t != null) {
      t(message, error: error);
    } else {
      showToast(context, message, error: error);
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(zaloDraftsProvider);
    ref.invalidate(zaloUnpaidProvider);
    try {
      await (_tab == 0 ? ref.read(zaloDraftsProvider.future) : ref.read(zaloUnpaidProvider.future));
    } catch (_) {}
  }

  Future<void> _cancelDraft(ZaloDraft d) async {
    final id = d.orderId;
    if (id == null) return;
    final ok = await confirmPos(
      context,
      title: 'Hủy đơn nháp?',
      message: 'Đơn ${d.orderCode ?? 'nháp'} (${money(d.total)}) sẽ bị hủy. Khách trên Zalo không được báo tự động.',
      action: 'Hủy đơn nháp',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await ref.read(apiProvider).post('/orders/$id/cancel');
      ref.invalidate(zaloDraftsProvider);
      _toast('Đã hủy đơn ${d.orderCode ?? 'nháp'}.');
    } catch (e) {
      _toast(posError(e), error: true);
      if (isStale(e)) ref.invalidate(zaloDraftsProvider);
    }
  }

  Future<void> _resend(Map<String, dynamic> o) async {
    final id = toInt(o['id']);
    try {
      final res = await ref.read(apiProvider).post('/orders/$id/resend-receipt');
      if (!mounted) return;
      if (res['sent'] == true) {
        _toast('Đã gửi lại hóa đơn qua Zalo.');
        ref.invalidate(zaloUnpaidProvider);
      } else {
        _toast('Chưa gửi được hóa đơn: ${res['error'] ?? 'lỗi không rõ'}', error: true);
      }
    } catch (e) {
      _toast(posError(e), error: true);
    }
  }

  Future<void> _collect(Map<String, dynamic> o) async {
    final id = toInt(o['id']);
    final api = ref.read(apiProvider);
    final code = '${o['order_code'] ?? ''}';
    final out = await showPaySheet(
      context,
      subtitle: '$code · ${o['customer_name'] ?? 'Khách Zalo'}',
      subtotal: toNum(o['total']),
      allowDiscount: false,
      onConfirm: (req) => payExistingOrder(api, id, req),
    );
    if (out == null || !mounted) return;
    _toast('Đã thanh toán ${out.code.isEmpty ? code : out.code}.${out.change > 0 ? ' Thối ${money(out.change)}.' : ''}');
    ref.invalidate(zaloUnpaidProvider);
  }

  @override
  Widget build(BuildContext context) {
    final drafts = ref.watch(zaloDraftsProvider);
    final unpaid = _tab == 1 ? ref.watch(zaloUnpaidProvider) : null;
    final isAdmin = ref.watch(currentUserProvider)?.isAdmin ?? false;

    final header = Padding(
      padding: EdgeInsets.fromLTRB(16, widget.inSheet ? 0 : 14, 8, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Đơn Zalo chờ khách xác nhận',
                  style: context.tt.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: Palette.navyDarker, height: 1.25),
                ),
              ),
              IconButton(tooltip: 'Tải lại', onPressed: _refresh, icon: const Icon(Icons.refresh_rounded)),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Text(
              'Khi khách trả lời "ok" trên Zalo, đơn tự hoàn tất và trừ kho.',
              style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              CountPill(label: 'Chờ xác nhận', count: drafts.value?.length, selected: _tab == 0, onTap: () => setState(() => _tab = 0)),
              CountPill(
                label: 'Chờ thu tiền',
                count: unpaid?.value?.length,
                countTone: Tone.warn,
                selected: _tab == 1,
                onTap: () => setState(() => _tab = 1),
              ),
            ],
          ),
          const SizedBox(height: 6),
        ],
      ),
    );

    final Widget body;
    if (_tab == 0) {
      body = AsyncBody<List<ZaloDraft>>(
        value: drafts,
        onRetry: () => ref.invalidate(zaloDraftsProvider),
        data: (list) => list.isEmpty
            ? const EmptyState(text: 'Không có đơn nào.', icon: Icons.mark_chat_read_outlined)
            : Column(
                children: [
                  for (final d in list)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                      child: _DraftCard(
                        draft: d,
                        expanded: d.orderId != null && _open.contains(d.orderId),
                        onToggle: d.orderId == null
                            ? null
                            : () => setState(() => _open.contains(d.orderId) ? _open.remove(d.orderId) : _open.add(d.orderId!)),
                        onCancel: d.orderId == null ? null : () => _cancelDraft(d),
                      ),
                    ),
                ],
              ),
      );
    } else {
      body = AsyncBody<List<Map<String, dynamic>>>(
        value: unpaid!,
        onRetry: () => ref.invalidate(zaloUnpaidProvider),
        data: (list) => list.isEmpty
            ? const EmptyState(text: 'Không có đơn Zalo nào chờ thu tiền.', icon: Icons.task_alt_rounded)
            : Column(
                children: [
                  for (final o in list)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                      child: _UnpaidCard(
                        order: o,
                        canCollect: isAdmin || o['customer_id'] == null,
                        onCollect: () => _collect(o),
                        onResend: () => _resend(o),
                      ),
                    ),
                ],
              ),
      );
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(controller: widget.scrollController, padding: const EdgeInsets.only(bottom: 24), children: [header, body]),
    );
  }
}

class _DraftCard extends ConsumerWidget {
  const _DraftCard({required this.draft, required this.expanded, required this.onToggle, required this.onCancel});
  final ZaloDraft draft;
  final bool expanded;
  final VoidCallback? onToggle;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final left = draft.minutesLeft();
    final sub = [draft.chatLabel, if (draft.lastActivityAt != null) shopClock(draft.lastActivityAt), if (left != null) 'còn $left phút'].join(' · ');
    return Container(
      decoration: BoxDecoration(
        color: context.cs.surface,
        border: Border.all(color: context.co.warn.withValues(alpha: 0.6), width: 1.5),
        borderRadius: BorderRadius.circular(12),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      draft.orderCode ?? 'Đơn nháp',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, fontFeatures: tabular),
                    ),
                    Text(sub, style: context.tt.bodySmall),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                money(draft.total),
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17, color: Palette.navy, fontFeatures: tabular),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: const [
              StatusBadge('Chờ khách xác nhận', tone: Tone.warn, dense: true),
              StatusBadge('Chưa trừ kho', dense: true),
            ],
          ),
          if (expanded && draft.orderId != null) _DraftItems(orderId: draft.orderId!),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: onToggle,
                icon: Icon(expanded ? Icons.expand_less_rounded : Icons.visibility_outlined, size: 18),
                label: Text(expanded ? 'Ẩn' : 'Xem'),
              ),
              const SizedBox(width: 4),
              TextButton.icon(
                onPressed: onCancel,
                style: TextButton.styleFrom(foregroundColor: context.co.bad),
                icon: const Icon(Icons.cancel_outlined, size: 18),
                label: const Text('Hủy'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DraftItems extends ConsumerWidget {
  const _DraftItems({required this.orderId});
  final int orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final order = ref.watch(posOrderProvider(orderId));
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: order.when(
        loading: () => const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator()),
        error: (e, _) => Text(posError(e), style: TextStyle(color: context.co.bad)),
        data: (o) {
          final items = mapList(o['items']);
          if (items.isEmpty) return Text('Đơn chưa có món nào.', style: context.tt.bodySmall);
          return Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: context.cs.surfaceContainerLow, borderRadius: BorderRadius.circular(8)),
            child: Column(
              children: [
                for (final it in items)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: '${qty(it['quantity'])}× ',
                                  style: const TextStyle(fontWeight: FontWeight.w700),
                                ),
                                TextSpan(text: '${it['product_name'] ?? ''}'),
                                if (strOrNull(it['note']) != null)
                                  TextSpan(
                                    text: ' (${it['note']})',
                                    style: TextStyle(color: context.co.muted, fontStyle: FontStyle.italic),
                                  ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(money(it['line_total']), style: const TextStyle(fontFeatures: tabular)),
                      ],
                    ),
                  ),
                if (strOrNull(o['note']) != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text('Ghi chú: ${o['note']}', style: context.tt.bodySmall),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _UnpaidCard extends StatelessWidget {
  const _UnpaidCard({required this.order, required this.canCollect, required this.onCollect, required this.onResend});
  final Map<String, dynamic> order;
  final bool canCollect;
  final VoidCallback onCollect;
  final VoidCallback onResend;

  @override
  Widget build(BuildContext context) {
    final customer = strOrNull(order['customer_name']);
    final receiptError = strOrNull(order['receipt_error']);
    final sub = [
      customer ?? 'Khách Zalo',
      if (order['item_count'] != null) '${qty(order['item_count'])} món',
      if (order['completed_at'] != null) shopClock(order['completed_at']),
    ].join(' · ');
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: context.cs.surface,
        border: Border.all(color: context.co.line),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Stack(
        children: [
          Positioned(left: 0, top: 0, bottom: 0, width: 4, child: ColoredBox(color: context.co.zalo)),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 12, 14, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${order['order_code'] ?? ''}',
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, fontFeatures: tabular),
                          ),
                          Text(sub, style: context.tt.bodySmall),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      money(order['total']),
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17, color: Palette.navy, fontFeatures: tabular),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    const StatusBadge('Khách đã xác nhận', tone: Tone.good, dense: true),
                    if (order['customer_id'] != null) const StatusBadge('Ghi nợ', tone: Tone.info, dense: true),
                    if (receiptError != null) const StatusBadge('Chưa gửi bill', tone: Tone.bad, dense: true),
                  ],
                ),
                if (!canCollect)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Đơn ghi nợ của khách quen: quản trị thu nợ ở trang Khách hàng.', style: context.tt.bodySmall),
                  ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: Wrap(
                    alignment: WrapAlignment.end,
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (receiptError != null)
                        OutlinedButton.icon(onPressed: onResend, icon: const Icon(Icons.send_rounded, size: 18), label: const Text('Gửi lại')),
                      if (canCollect)
                        FilledButton.icon(onPressed: onCollect, icon: const Icon(Icons.payments_outlined, size: 20), label: const Text('Thu tiền')),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
