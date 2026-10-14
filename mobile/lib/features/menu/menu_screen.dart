import 'package:flutter/material.dart' hide Thumb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/nav.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_shell.dart';
import '../../core/widgets/common.dart';
import 'form_sheet.dart';
import 'menu_models.dart';
import 'menu_sheets.dart';

/// Thực đơn (views/pages/menu.ejs): header with "+ Nhóm món" / "+ Hàng bán lẻ", the NHÓM MÓN chips, then
/// MÓN (n) with the filter box and the product table (cards on phones, a table from 840 dp).
/// Cashiers see the same lists read-only.
class MenuScreen extends ConsumerWidget {
  const MenuScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(menuDataProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Thực đơn')),
      body: AsyncBody(
        value: data,
        onRetry: () => ref.invalidate(menuDataProvider),
        data: (d) => RefreshIndicator(
          onRefresh: () => ref.refresh(menuDataProvider.future),
          child: _MenuBody(data: d),
        ),
      ),
    );
  }
}

class _MenuBody extends ConsumerWidget {
  const _MenuBody({required this.data});
  final MenuData data;

  Future<void> _openProduct(BuildContext context, WidgetRef ref, [MenuProduct? p]) async {
    final name = await showFormSheet<String>(
      context,
      maxWidth: 512,
      builder: (_) => ProductForm(product: p, categories: data.categories, items: data.items),
    );
    if (name == null || !context.mounted) return;
    ref.invalidate(menuDataProvider);
    showToast(context, p == null ? 'Đã thêm $name.' : 'Đã cập nhật $name.');
  }

  Future<void> _openCategory(BuildContext context, WidgetRef ref, [MenuCategory? c]) async {
    final ok = await showFormSheet<bool>(context, builder: (_) => CategoryForm(category: c));
    if (ok != true || !context.mounted) return;
    ref.invalidate(menuDataProvider);
    showToast(context, c == null ? 'Đã thêm nhóm món.' : 'Đã cập nhật nhóm món.');
  }

  /// Quick "Đang bán" switch: PUT /api/products/:id { is_active }.
  Future<void> _setActive(BuildContext context, WidgetRef ref, MenuProduct p, bool active) async {
    await runWithToast(context, () async {
      await ref.read(apiProvider).put('/products/${p.id}', {'is_active': active});
      ref.invalidate(menuDataProvider);
    }, success: 'Đã cập nhật ${p.name}.');
  }

  void _openBom(BuildContext context, WidgetRef ref) {
    final bom = navGroups.expand((g) => g.items).firstWhere((i) => i.key == 'bom');
    openNavItem(context, ref, bom);
  }

  List<Widget> _actions(BuildContext context, WidgetRef ref, MenuProduct p, bool admin) => [
        if (admin)
          Tooltip(
            message: p.isActive ? 'Đang bán' : 'Ngừng bán',
            child: Switch(value: p.isActive, onChanged: (v) => _setActive(context, ref, p, v)),
          ),
        if (admin) GhostAction(label: 'Sửa', icon: Icons.edit_outlined, tooltip: 'Sửa ${p.name}', onPressed: () => _openProduct(context, ref, p)),
        if (admin && p.isBom) GhostAction(label: 'Công thức', onPressed: () => _openBom(context, ref)),
      ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    final query = ref.watch(menuQueryProvider);
    final shown = [for (final p in data.products) if (productMatches(p, query)) p];
    final emptyText = data.products.isEmpty ? 'Chưa có món nào.' : 'Không có món phù hợp.';

    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= kTableBreakpoint;
      final search = TextField(
        onChanged: ref.read(menuQueryProvider.notifier).set,
        decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded, size: 20), hintText: 'Tìm theo tên, SKU, từ khóa…'),
      );
      final buttons = [
        OutlinedButton(onPressed: () => _openCategory(context, ref), child: const Text('+ Nhóm món')),
        FilledButton(onPressed: () => _openProduct(context, ref), child: const Text('+ Hàng bán lẻ')),
      ];
      final desc = Text(
        'Giá bán, nhóm món và từ khóa đặt món qua Zalo. Đồ uống pha chế được tạo và chỉnh nguyên liệu ở Công thức (BOM); '
        'hàng bán lẻ (thuốc lá, nước đóng chai) thêm tại đây.',
        style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
      );

      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          PageWidth(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              // 1. Header
              if (wide && admin)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: desc),
                  const SizedBox(width: 16),
                  buttons[0],
                  const SizedBox(width: 12),
                  buttons[1],
                ])
              else ...[
                desc,
                if (admin) ...[
                  const SizedBox(height: 12),
                  Row(children: [Expanded(child: buttons[0]), const SizedBox(width: 12), Expanded(child: buttons[1])]),
                ],
              ],
              const SizedBox(height: 20),
              // 2. Nhóm món
              const SectionLabel('Nhóm món'),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final cat in data.categories)
                  _CategoryChip(category: cat, onTap: admin ? () => _openCategory(context, ref, cat) : null),
              ]),
              const SizedBox(height: 24),
              // 3. Món
              if (wide)
                Row(children: [
                  Expanded(child: SectionLabel('Món (${data.products.length})')),
                  SizedBox(width: 320, child: search),
                ])
              else ...[
                SectionLabel('Món (${data.products.length})'),
                const SizedBox(height: 8),
                search,
              ],
              const SizedBox(height: 12),
              if (wide)
                WideTable(
                  columns: const [
                    WideColumn('Món', flex: 4),
                    WideColumn('Nhóm', flex: 2),
                    WideColumn('Trừ kho', flex: 2),
                    WideColumn('Giá bán', flex: 2, end: true),
                    WideColumn('Trạng thái', flex: 2),
                    WideColumn('', flex: 4, end: true),
                  ],
                  empty: EmptyState(text: emptyText, icon: Icons.local_cafe_outlined),
                  rows: [
                    for (final p in shown)
                      WideRow(dimmed: !p.isActive, cells: [
                        _ProductTitle(product: p),
                        Text(p.categoryName),
                        _StockMode(product: p, alignEnd: false),
                        _Price(p.price),
                        _ActiveBadge(p.isActive),
                        Wrap(alignment: WrapAlignment.end, crossAxisAlignment: WrapCrossAlignment.center, children: _actions(context, ref, p, admin)),
                      ]),
                  ],
                )
              else if (shown.isEmpty)
                Card(child: EmptyState(text: emptyText, icon: Icons.local_cafe_outlined))
              else
                CardGrid(children: [
                  for (final p in shown)
                    RowCard(
                      dimmed: !p.isActive,
                      title: _ProductTitle(product: p),
                      fields: [
                        ('Nhóm', Text(p.categoryName, textAlign: TextAlign.right)),
                        ('Trừ kho', _StockMode(product: p, alignEnd: true)),
                        ('Giá bán', _Price(p.price)),
                        ('Trạng thái', _ActiveBadge(p.isActive)),
                      ],
                      actions: _actions(context, ref, p, admin),
                    ),
                ]),
            ]),
          ),
        ],
      );
    });
  }
}

/// '{name} #{sort_order}' chip; inactive groups are grey with '(ẩn)'.
class _CategoryChip extends StatelessWidget {
  const _CategoryChip({required this.category, this.onTap});
  final MenuCategory category;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = category;
    final fg = c.isActive ? context.cs.onSurface : context.co.muted;
    return Material(
      color: context.cs.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(6),
        side: BorderSide(color: c.isActive ? context.cs.outline : context.co.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(c.name, style: TextStyle(color: fg, fontSize: 14)),
            const SizedBox(width: 6),
            Text('#${c.sortOrder}', style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: context.co.muted)),
            if (!c.isActive) ...[const SizedBox(width: 4), Text('(ẩn)', style: TextStyle(fontSize: 12, color: fg))],
          ]),
        ),
      ),
    );
  }
}

/// Photo, name, then "SKU · extra keywords".
class _ProductTitle extends StatelessWidget {
  const _ProductTitle({required this.product});
  final MenuProduct product;

  @override
  Widget build(BuildContext context) {
    final p = product;
    final extra = p.extraAliases;
    return Row(children: [
      Thumb(url: p.imageUrl, name: p.name),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(p.name, style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: p.sku, style: const TextStyle(fontFamily: 'monospace')),
              if (extra.isNotEmpty) TextSpan(text: ' · ${extra.join(', ')}'),
            ]),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: context.tt.bodySmall,
          ),
        ]),
      ),
    ]);
  }
}

class _StockMode extends StatelessWidget {
  const _StockMode({required this.product, required this.alignEnd});
  final MenuProduct product;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(product.modeLabel),
        if (product.inventoryItemName != null)
          Text(product.inventoryItemName!, style: context.tt.bodySmall, textAlign: alignEnd ? TextAlign.right : TextAlign.left),
      ],
    );
  }
}

class _Price extends StatelessWidget {
  const _Price(this.price);
  final num price;

  @override
  Widget build(BuildContext context) =>
      Text(money(price), style: const TextStyle(fontFeatures: tabular, fontWeight: FontWeight.w600));
}

class _ActiveBadge extends StatelessWidget {
  const _ActiveBadge(this.active);
  final bool active;

  @override
  Widget build(BuildContext context) =>
      active ? const StatusBadge('Đang bán', tone: Tone.good) : const StatusBadge('Ngừng bán', tone: Tone.neutral);
}
