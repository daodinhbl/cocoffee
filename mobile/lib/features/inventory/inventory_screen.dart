import 'package:flutter/material.dart' hide Thumb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'inventory_data.dart';
import 'inventory_forms.dart';
import 'inventory_widgets.dart';

/// "Nguyên liệu" (views/pages/inventory.ejs): 4 summary cards, Tất cả / Sắp hết pills + search, the stock table
/// (cards on phones), and the add / edit / stocktake dialogs for admins.
class InventoryScreen extends ConsumerWidget {
  const InventoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(inventoryListProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Nguyên liệu')),
      body: AsyncBody(
        value: data,
        onRetry: () => ref.invalidate(inventoryListProvider),
        data: (d) => RefreshIndicator(
          onRefresh: () => ref.refresh(inventoryListProvider.future),
          child: _InventoryBody(data: d),
        ),
      ),
    );
  }
}

class _InventoryBody extends ConsumerWidget {
  const _InventoryBody({required this.data});
  final InventoryData data;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    final filter = ref.watch(inventoryFilterProvider);
    final notifier = ref.read(inventoryFilterProvider.notifier);
    final low = data.lowCount, out = data.outCount;
    final base = filter.lowOnly ? data.items.where((i) => i.isActive && i.isLow).toList() : data.items;
    final q = foldVi(filter.query.trim());
    final shown = q.isEmpty ? base : base.where((i) => foldVi(i.name).contains(q) || foldVi(i.sku).contains(q)).toList();
    final emptyText = base.isNotEmpty
        ? 'Không có mặt hàng phù hợp.'
        : (filter.lowOnly ? 'Không có mặt hàng nào dưới mức tối thiểu.' : 'Chưa có nguyên liệu nào.');

    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= kWide;
      final pills = SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          CountPill(
            key: const ValueKey('pill-all'),
            label: 'Tất cả',
            count: data.items.length,
            selected: !filter.lowOnly,
            onTap: () => notifier.setLowOnly(false),
          ),
          const SizedBox(width: 8),
          CountPill(
            key: const ValueKey('pill-low'),
            label: 'Sắp hết',
            count: low,
            selected: filter.lowOnly,
            countTone: low > 0 ? Tone.warn : null,
            onTap: () => notifier.setLowOnly(true),
          ),
        ]),
      );
      final search = TextField(
        key: const ValueKey('inventory-search'),
        onChanged: notifier.setQuery,
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          prefixIcon: Icon(Icons.search_rounded, size: 20, color: context.co.muted),
          hintText: 'Tìm theo tên hoặc SKU…',
        ),
      );

      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
            child: Text(
              'Tồn kho nguyên liệu và hàng bán lẻ. Kho tự trừ khi đơn hoàn tất; nhập hàng ở Nhập kho để giá vốn bình quân được cập nhật.',
              style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14),
            ),
          ),
          if (admin)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(mainAxisAlignment: wide ? MainAxisAlignment.end : MainAxisAlignment.start, children: [
                Flexible(
                  child: OutlinedButton.icon(
                    onPressed: () => context.push('/receiving'),
                    icon: const Icon(Icons.upload_rounded, size: 18),
                    label: const Text('Nhập kho', maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: FilledButton.icon(
                    key: const ValueKey('add-item'),
                    onPressed: () => openItemForm(context),
                    icon: const Icon(Icons.add_rounded, size: 20),
                    label: const Text('Thêm nguyên liệu', maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
              ]),
            ),
          const SizedBox(height: 16),
          StatGrid(children: [
            StatCard(
              label: 'Mặt hàng đang dùng',
              value: '${data.active.length}',
              sub: '${data.items.length - data.active.length} ngừng dùng',
              icon: Icons.inventory_2_outlined,
            ),
            StatCard(
              label: 'Dưới mức tối thiểu',
              value: '$low',
              sub: low > 0 ? 'Cần nhập thêm →' : 'Không có mục nào',
              icon: Icons.notifications_none_rounded,
              tone: Tone.warn,
              valueColor: low > 0 ? context.co.warn : null,
              onTap: () => notifier.setLowOnly(true),
            ),
            StatCard(
              label: 'Hết hàng',
              value: '$out',
              sub: 'Món dùng nguyên liệu này sẽ báo hết',
              icon: Icons.close_rounded,
              tone: Tone.bad,
              valueColor: out > 0 ? context.co.bad : null,
            ),
            StatCard(
              label: 'Giá trị tồn kho',
              value: money(data.stockValue),
              sub: 'Theo giá vốn bình quân',
              icon: Icons.bar_chart_rounded,
              tone: Tone.info,
            ),
          ]),
          const SizedBox(height: 20),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: wide
                ? Row(children: [Expanded(child: Align(alignment: Alignment.centerLeft, child: pills)), const SizedBox(width: 16), SizedBox(width: 320, child: search)])
                : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [pills, const SizedBox(height: 12), search]),
          ),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: wide
                ? _InventoryTable(items: shown, admin: admin, emptyText: emptyText)
                : shown.isEmpty
                    ? _EmptyBox(text: emptyText)
                    : CardColumn(children: [for (final i in shown) _ItemCard(item: i, admin: admin)]),
          ),
        ],
      );
    });
  }
}

class _EmptyBox extends StatelessWidget {
  const _EmptyBox({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
      decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(12)),
      child: Text(text, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
    );
  }
}

/// Photo or initial + name (link) + "sku · unit".
class _ItemTitle extends StatelessWidget {
  const _ItemTitle({required this.item, required this.admin});
  final InvItem item;
  final bool admin;

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Thumb(url: item.imageUrl, name: item.name, size: 40),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(item.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: admin ? linkStyle(context) : const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text('${item.sku} · ${item.unit}', style: context.tt.bodySmall?.copyWith(fontFamily: 'monospace', fontSize: 12)),
        ]),
      ),
    ]);
  }
}

/// Opens the item page; the detail API is admin-only, so cashiers stay on the list.
VoidCallback? _openDetail(BuildContext context, InvItem item, bool admin) => admin ? () => context.push('/inventory/${item.id}') : null;

class _ItemCard extends StatelessWidget {
  const _ItemCard({required this.item, required this.admin});
  final InvItem item;
  final bool admin;

  @override
  Widget build(BuildContext context) {
    final lv = stockLevel(item);
    return RowCard(
      key: ValueKey('inv-row-${item.id}'),
      muted: !item.isActive,
      onTap: _openDetail(context, item, admin),
      title: _ItemTitle(item: item, admin: admin),
      fields: [
        (
          'Tồn kho',
          Text.rich(TextSpan(children: [
            TextSpan(text: qty(item.quantity), style: numStyle(context, weight: FontWeight.w600)),
            TextSpan(text: ' ${item.unit}', style: TextStyle(color: context.co.muted)),
          ])),
        ),
        ('Tối thiểu', Text(qty(item.minStock), style: numStyle(context, color: context.co.muted))),
        ('Giá vốn BQ', Text(money(item.avgCost), style: numStyle(context))),
        ('Giá trị', Text(money(item.stockValue), style: numStyle(context, weight: FontWeight.w600))),
        ('Tình trạng', StatusBadge(lv.text, tone: lv.tone, dense: true)),
      ],
      actions: admin ? _rowActions(context, item) : const [],
    );
  }
}

List<Widget> _rowActions(BuildContext context, InvItem item, {bool compactEdit = false}) {
  final style = compactOutlined(context);
  return [
    OutlinedButton.icon(
      key: ValueKey('receive-${item.id}'),
      style: style,
      onPressed: () => context.push('/receiving?item=${item.id}'),
      icon: const Icon(Icons.upload_rounded, size: 16),
      label: const Text('Nhập'),
    ),
    OutlinedButton(
      key: ValueKey('adjust-${item.id}'),
      style: style.copyWith(foregroundColor: WidgetStatePropertyAll(context.cs.onSurface)),
      onPressed: () => openAdjust(context, item),
      child: const Text('Kiểm kê'),
    ),
    if (compactEdit)
      IconButton(
        key: ValueKey('edit-${item.id}'),
        tooltip: 'Sửa',
        onPressed: () => openItemForm(context, item: item),
        icon: Icon(Icons.edit_outlined, size: 20, color: context.co.muted),
      )
    else
      OutlinedButton.icon(
        key: ValueKey('edit-${item.id}'),
        style: style.copyWith(foregroundColor: WidgetStatePropertyAll(context.cs.onSurface)),
        onPressed: () => openItemForm(context, item: item),
        icon: const Icon(Icons.edit_outlined, size: 16),
        label: const Text('Sửa'),
      ),
  ];
}

/// Wide layout: the web table (Mặt hàng, Tồn kho + level bar, Tối thiểu, Giá vốn BQ, Giá trị, Tình trạng, actions).
class _InventoryTable extends StatelessWidget {
  const _InventoryTable({required this.items, required this.admin, required this.emptyText});
  final List<InvItem> items;
  final bool admin;
  final String emptyText;

  static const _flex = [30, 18, 10, 12, 13, 11];
  static const _actionsWidth = 292.0;

  Widget _row(List<Widget> cells, {Widget? actions}) {
    return Row(children: [
      for (var i = 0; i < cells.length; i++) ...[
        if (i > 0) const SizedBox(width: 12),
        Expanded(flex: _flex[i], child: cells[i]),
      ],
      if (admin) SizedBox(width: _actionsWidth, child: actions ?? const SizedBox.shrink()),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return TableCard(
      header: _row(const [
        HeadCell('Mặt hàng'),
        HeadCell('Tồn kho'),
        HeadCell('Tối thiểu', right: true),
        HeadCell('Giá vốn BQ', right: true),
        HeadCell('Giá trị', right: true),
        HeadCell('Tình trạng'),
      ]),
      empty: Padding(
        padding: const EdgeInsets.symmetric(vertical: 48),
        child: Text(emptyText, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
      ),
      rows: [
        for (final i in items)
          Opacity(
            key: ValueKey('inv-row-${i.id}'),
            opacity: i.isActive ? 1 : 0.6,
            child: InkWell(
              onTap: _openDetail(context, i, admin),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: _row(
                  [
                    _ItemTitle(item: i, admin: admin),
                    _LevelCell(item: i),
                    Text(qty(i.minStock), textAlign: TextAlign.right, style: numStyle(context, color: context.co.muted)),
                    Text(money(i.avgCost), textAlign: TextAlign.right, style: numStyle(context)),
                    Text(money(i.stockValue), textAlign: TextAlign.right, style: numStyle(context, weight: FontWeight.w600)),
                    Align(alignment: Alignment.centerLeft, child: StatusBadge(stockLevel(i).text, tone: stockLevel(i).tone, dense: true)),
                  ],
                  actions: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                    for (final (n, w) in _rowActions(context, i, compactEdit: true).indexed) ...[if (n > 0) const SizedBox(width: 6), w],
                  ]),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _LevelCell extends StatelessWidget {
  const _LevelCell({required this.item});
  final InvItem item;

  @override
  Widget build(BuildContext context) {
    final lv = stockLevel(item);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text.rich(TextSpan(children: [
        TextSpan(text: qty(item.quantity), style: numStyle(context, weight: FontWeight.w600)),
        TextSpan(text: ' ${item.unit}', style: TextStyle(color: context.co.muted)),
      ])),
      const SizedBox(height: 6),
      LevelBar(fraction: lv.fraction, color: lv.color(context)),
    ]);
  }
}
