import 'package:flutter/material.dart' hide Thumb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/nav.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_shell.dart';
import '../../core/widgets/common.dart';
import 'inventory_data.dart';
import 'inventory_forms.dart';
import 'inventory_widgets.dart';

/// Item page (views/pages/inventory_detail.ejs): header with photo, badge and quick actions; Tồn kho / Giá vốn bình quân /
/// Giá trị tồn / Tiêu hao 30 ngày; the stock trend chart; the drinks using the item; the ledger with type pills.
class InventoryDetailScreen extends ConsumerWidget {
  const InventoryDetailScreen({super.key, required this.id});
  final int id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(inventoryDetailProvider(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Nguyên liệu')),
      body: AsyncBody(
        value: detail,
        onRetry: () => ref.invalidate(inventoryDetailProvider(id)),
        data: (d) => RefreshIndicator(
          onRefresh: () => ref.refresh(inventoryDetailProvider(id).future),
          child: _DetailBody(detail: d),
        ),
      ),
    );
  }
}

class _DetailBody extends ConsumerWidget {
  const _DetailBody({required this.detail});
  final InvDetail detail;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final item = detail.item;
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= kWide;
      final chart = StockTrendChart(movements: detail.movements, unit: item.unit, minStock: item.minStock);
      final usedIn = _UsedInCard(detail: detail);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 0), child: _HeaderCard(detail: detail, wide: c.maxWidth >= 600)),
          const SizedBox(height: 16),
          _KeyNumbers(detail: detail),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: wide
                ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Expanded(flex: 2, child: chart),
                    const SizedBox(width: 16),
                    Expanded(child: usedIn),
                  ])
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [chart, const SizedBox(height: 16), usedIn]),
          ),
          const SizedBox(height: 16),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: _Ledger(detail: detail, wide: wide)),
        ],
      );
    });
  }
}

class _HeaderCard extends ConsumerWidget {
  const _HeaderCard({required this.detail, required this.wide});
  final InvDetail detail;
  final bool wide;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final item = detail.item;
    final lv = stockLevel(item);
    final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    final meta = 'đơn vị ${item.unit}${detail.usedIn.isNotEmpty ? ' · dùng trong ${detail.usedIn.length} món' : ''}';
    final identity = Row(children: [
      Thumb(url: item.imageUrl, name: item.name, size: wide ? 72 : 64),
      const SizedBox(width: 16),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Text(item.name, style: context.tt.titleLarge?.copyWith(fontSize: wide ? 24 : 20)),
            StatusBadge(lv.text, tone: lv.tone),
          ]),
          const SizedBox(height: 4),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: item.sku, style: const TextStyle(fontFamily: 'monospace')),
              TextSpan(text: ' · $meta'),
            ]),
            style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14),
          ),
        ]),
      ),
    ]);

    final pad = EdgeInsets.symmetric(horizontal: wide ? 16 : 6);
    final buttons = [
      FilledButton.icon(
        key: const ValueKey('detail-receive'),
        style: FilledButton.styleFrom(padding: pad),
        onPressed: () => context.push('/receiving?item=${item.id}'),
        icon: const Icon(Icons.upload_rounded, size: 18),
        label: const Text('Nhập kho', maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      OutlinedButton.icon(
        key: const ValueKey('detail-adjust'),
        style: OutlinedButton.styleFrom(padding: pad),
        onPressed: () => openAdjust(context, item),
        icon: const Icon(Icons.tune_rounded, size: 18),
        label: const Text('Kiểm kê', maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      OutlinedButton.icon(
        key: const ValueKey('detail-edit'),
        style: OutlinedButton.styleFrom(padding: pad),
        onPressed: () => openItemForm(context, item: item),
        icon: const Icon(Icons.edit_outlined, size: 18),
        label: const Text('Sửa', maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    ];

    return Card(
      child: Padding(
        padding: EdgeInsets.all(wide ? 20 : 16),
        child: wide
            ? Row(children: [
                Expanded(child: identity),
                if (admin) ...[
                  const SizedBox(width: 16),
                  for (final (i, b) in buttons.indexed) ...[if (i > 0) const SizedBox(width: 8), b],
                ],
              ])
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                identity,
                if (admin) ...[
                  const SizedBox(height: 14),
                  Row(children: [
                    for (final (i, b) in buttons.indexed) ...[if (i > 0) const SizedBox(width: 8), Expanded(child: b)],
                  ]),
                ],
              ]),
      ),
    );
  }
}

class _KeyNumbers extends StatelessWidget {
  const _KeyNumbers({required this.detail});
  final InvDetail detail;

  @override
  Widget build(BuildContext context) {
    final item = detail.item;
    final u = detail.usage;
    final q = item.quantity, min = item.minStock, cost = item.avgCost;
    final lv = stockLevel(item);
    final perDay = u.used / u.days;
    final cover = perDay > 0 ? q / perDay : null;
    final coverText = cover == null
        ? null
        : cover < 1
            ? 'dưới 1 ngày'
            : cover > 365
                ? 'trên 1 năm'
                : 'khoảng ${qty(cover.round())} ngày';
    final usageSub = StringBuffer(u.used > 0
        ? 'TB ${qty((perDay * 10).round() / 10)} ${item.unit}/ngày · đủ dùng $coverText'
        : 'Chưa xuất bán trong ${u.days} ngày qua');
    if (u.wasted > 0) usageSub.write(' · hao hụt ${qty(u.wasted)}');
    final lp = u.lastPurchase;

    return StatGrid(children: [
      StatCard(
        label: 'Tồn kho',
        value: '${qty(q)} ${item.unit}',
        icon: Icons.inventory_2_outlined,
        valueColor: lv.tone == Tone.bad ? context.co.bad : lv.tone == Tone.warn ? context.co.warn : null,
        footer: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          // Full at 3x the minimum; the tick marks the minimum (a third of the way).
          LevelBar(fraction: lv.fraction, color: lv.color(context), markAt: min > 0 ? 1 / 3 : null),
          const SizedBox(height: 6),
          Text(min > 0 ? 'Tối thiểu ${qty(min)} ${item.unit}' : 'Chưa đặt mức tối thiểu',
              maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall),
        ]),
      ),
      StatCard(
        label: 'Giá vốn bình quân',
        value: '${money(cost)} / ${item.unit}',
        sub: lp != null ? 'Nhập gần nhất ${money(lp.unitCost)} · ${shopDay(lp.createdAt)}' : 'Chưa có phiếu nhập kho',
        icon: Icons.receipt_long_rounded,
        tone: Tone.info,
      ),
      StatCard(
        label: 'Giá trị tồn',
        value: money(q * cost),
        sub: 'Tồn kho × giá vốn bình quân',
        icon: Icons.bar_chart_rounded,
      ),
      StatCard(
        label: 'Tiêu hao ${u.days} ngày',
        value: '${qty(u.used)} ${item.unit}',
        sub: usageSub.toString(),
        icon: Icons.science_outlined,
        tone: Tone.warn,
      ),
    ]);
  }
}

/// "Dùng trong món": BOM lines (quantity per serving) and retail goods sold 1:1 from this item.
class _UsedInCard extends ConsumerWidget {
  const _UsedInCard({required this.detail});
  final InvDetail detail;

  void _openBom(BuildContext context, WidgetRef ref) {
    final bom = navGroups.expand((g) => g.items).firstWhere((i) => i.key == 'bom');
    openNavItem(context, ref, bom);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final item = detail.item;
    final rows = detail.usedIn;
    return SectionCard(
      title: 'Dùng trong món',
      subtitle: 'Định mức cho mỗi phần bán ra',
      trailing: TextButton(onPressed: () => _openBom(context, ref), child: const Text('Công thức →')),
      child: rows.isEmpty
          ? Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text('Chưa có món nào dùng nguyên liệu này.',
                  textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
            )
          : Column(children: [
              for (final (i, p) in rows.indexed) ...[
                if (i > 0) const Divider(),
                Opacity(
                  opacity: p.isActive ? 1 : 0.6,
                  child: InkWell(
                    onTap: () => p.direct ? context.push('/menu') : _openBom(context, ref),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(children: [
                        Thumb(url: p.imageUrl, name: p.name, size: 36),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14)),
                            Text(
                              '${p.direct ? 'Bán lẻ, trừ 1 : 1' : '${qty(p.quantity)} ${item.unit} / phần'}${p.isActive ? '' : ' · ngừng bán'}',
                              style: context.tt.bodySmall,
                            ),
                          ]),
                        ),
                        const SizedBox(width: 8),
                        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                          Text(money((p.quantity * item.avgCost).round()), style: numStyle(context, weight: FontWeight.w600)),
                          Text('giá vốn / phần', style: context.tt.bodySmall?.copyWith(fontSize: 11)),
                        ]),
                      ]),
                    ),
                  ),
                ),
              ],
            ]),
    );
  }
}

/// "Lịch sử xuất nhập": type pills (only types that have rows), then rows (cards on phones, a table when wide).
class _Ledger extends ConsumerWidget {
  const _Ledger({required this.detail, required this.wide});
  final InvDetail detail;
  final bool wide;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final item = detail.item;
    final all = detail.movements;
    final type = ref.watch(ledgerTypeProvider(item.id));
    final pick = ref.read(ledgerTypeProvider(item.id).notifier);
    final counts = {for (final t in movementTypes) t: all.where((m) => m.type == t).length};
    final shown = type == null ? all : all.where((m) => m.type == type).toList();
    final emptyText = all.isNotEmpty ? 'Không có lần nào thuộc loại này.' : 'Chưa có biến động nào. Nhập kho lần đầu để bắt đầu theo dõi.';

    final heading = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text('Lịch sử xuất nhập', style: context.tt.titleMedium),
      Text(all.length >= 200 ? '200 lần gần nhất' : '${all.length} lần', style: context.tt.bodySmall),
    ]);
    final pills = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(children: [
        CountPill(key: const ValueKey('ledger-all'), label: 'Tất cả', count: all.length, selected: type == null, onTap: () => pick.select(null)),
        for (final t in movementTypes)
          if ((counts[t] ?? 0) > 0 || t == type) ...[
            const SizedBox(width: 8),
            CountPill(
              key: ValueKey('ledger-$t'),
              label: moveMeta(t).label,
              count: counts[t],
              selected: type == t,
              onTap: () => pick.select(t),
            ),
          ],
      ]),
    );

    Widget change(Movement m) {
      final color = m.change < 0 ? context.co.bad : m.change > 0 ? context.co.good : context.co.muted;
      return Text.rich(TextSpan(children: [
        TextSpan(text: signed(m.change), style: numStyle(context, weight: FontWeight.w600, color: color)),
        TextSpan(text: ' ${item.unit}', style: TextStyle(color: context.co.muted)),
      ]));
    }

    Widget voucher(Movement m) {
      final text = m.note?.isNotEmpty == true ? m.note! : (m.orderId != null ? '#${m.orderId}' : '—');
      if (m.orderId == null) return Text(text, style: TextStyle(color: context.cs.onSurfaceVariant));
      return InkWell(
        onTap: () => context.push('/orders/${m.orderId}'),
        child: Text(text, style: linkStyle(context, size: 13.5).copyWith(fontFamily: 'monospace')),
      );
    }

    String who(Movement m) => m.createdByName?.isNotEmpty == true ? m.createdByName! : (m.orderId != null ? 'Tự động (đơn hàng)' : '—');
    String unitCost(Movement m) => m.unitCost != 0 ? money(m.unitCost) : '—';

    if (!wide) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        heading,
        const SizedBox(height: 10),
        pills,
        const SizedBox(height: 12),
        if (shown.isEmpty)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
            decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(12)),
            child: Text(emptyText, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
          )
        else
          CardColumn(children: [
            for (final m in shown)
              RowCard(
                key: ValueKey('mv-${m.id}'),
                title: Text(shopTime(m.createdAt), style: const TextStyle(fontWeight: FontWeight.w600, fontFeatures: tabular)),
                fields: [
                  ('Loại', MoveTypeChip(m.type)),
                  ('Thay đổi', change(m)),
                  ('Tồn sau', Text(qty(m.balanceAfter), style: numStyle(context))),
                  ('Đơn giá', Text(unitCost(m), style: numStyle(context, color: context.co.muted))),
                  ('Chứng từ', voucher(m)),
                  ('Người ghi', Text(who(m), style: TextStyle(color: context.co.muted))),
                ],
              ),
          ]),
      ]);
    }

    const flex = [15, 13, 11, 9, 10, 22, 14];
    Widget row(List<Widget> cells) => Row(children: [
          for (var i = 0; i < cells.length; i++) ...[if (i > 0) const SizedBox(width: 12), Expanded(flex: flex[i], child: cells[i])],
        ]);

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Row(children: [heading, const SizedBox(width: 16), Expanded(child: Align(alignment: Alignment.centerRight, child: pills))]),
        ),
        const Divider(),
        Container(
          color: context.cs.surfaceContainerLow,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: row(const [
            HeadCell('Thời gian'),
            HeadCell('Loại'),
            HeadCell('Thay đổi', right: true),
            HeadCell('Tồn sau', right: true),
            HeadCell('Đơn giá', right: true),
            HeadCell('Chứng từ / ghi chú'),
            HeadCell('Người ghi'),
          ]),
        ),
        const Divider(),
        if (shown.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 48),
            child: Text(emptyText, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
          ),
        for (final (i, m) in shown.indexed) ...[
          if (i > 0) const Divider(),
          Padding(
            key: ValueKey('mv-${m.id}'),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: row([
              Text(shopTime(m.createdAt), style: numStyle(context)),
              Align(alignment: Alignment.centerLeft, child: MoveTypeChip(m.type)),
              Align(alignment: Alignment.centerRight, child: change(m)),
              Text(qty(m.balanceAfter), textAlign: TextAlign.right, style: numStyle(context)),
              Text(unitCost(m), textAlign: TextAlign.right, style: numStyle(context, color: context.co.muted)),
              Align(alignment: Alignment.centerLeft, child: voucher(m)),
              Text(who(m), style: TextStyle(color: context.co.muted)),
            ]),
          ),
        ],
      ]),
    );
  }
}
