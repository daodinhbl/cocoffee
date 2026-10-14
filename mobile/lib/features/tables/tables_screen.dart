import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import 'table_models.dart';
import 'table_sheet.dart';

/// Bàn (views/pages/tables.ejs): "{n} bàn đang dùng · {m} bàn có khách", "+ Thêm bàn", then the table list
/// (cards on phones, a table from 840 dp). Tapping an active table opens it in the POS.
class TablesScreen extends ConsumerWidget {
  const TablesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tables = ref.watch(tablesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bàn')),
      body: AsyncBody(
        value: tables,
        onRetry: () => ref.invalidate(tablesProvider),
        data: (list) => RefreshIndicator(
          onRefresh: () => ref.refresh(tablesProvider.future),
          child: _TablesBody(tables: list),
        ),
      ),
    );
  }
}

class _TablesBody extends ConsumerWidget {
  const _TablesBody({required this.tables});
  final List<DiningTable> tables;

  Future<void> _openForm(BuildContext context, WidgetRef ref, [DiningTable? t]) async {
    final code = await showFormSheet<String>(context, builder: (_) => TableForm(table: t));
    if (code == null || !context.mounted) return;
    ref.invalidate(tablesProvider);
    showToast(context, t == null ? 'Đã thêm bàn $code.' : 'Đã cập nhật bàn.');
  }

  /// 'Ngừng dùng' / 'Dùng lại': PUT /api/tables/:id { is_active }.
  Future<void> _toggle(BuildContext context, WidgetRef ref, DiningTable t) async {
    if (t.isActive && !await confirmAction(context, 'Ngừng sử dụng ${t.name}? Bàn sẽ ẩn khỏi sơ đồ POS.')) return;
    if (!context.mounted) return;
    await runWithToast(context, () async {
      try {
        await ref.read(apiProvider).put('/tables/${t.id}', {'is_active': !t.isActive});
      } on ApiException catch (e) {
        if (e.code != 'CONFLICT') rethrow;
        throw ApiException(
          code: e.code,
          status: e.status,
          serverMessage: e.serverMessage,
          message: 'Bàn đang có đơn, hãy thanh toán hoặc hủy đơn trước khi ngừng sử dụng.',
        );
      }
      ref.invalidate(tablesProvider);
    }, success: 'Đã cập nhật bàn.');
  }

  void _openPos(BuildContext context, DiningTable t) => context.push('/pos?table=${t.id}');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    final activeCount = tables.where((t) => t.isActive).length;
    final serving = tables.where((t) => t.serving).length;

    List<Widget> actions(DiningTable t) => [
          if (admin) GhostAction(label: 'Sửa', icon: Icons.edit_outlined, tooltip: 'Sửa ${t.name}', onPressed: () => _openForm(context, ref, t)),
          if (admin && !t.serving) GhostAction(label: t.isActive ? 'Ngừng dùng' : 'Dùng lại', onPressed: () => _toggle(context, ref, t)),
        ];
    Widget orderCell(DiningTable t, {required bool end}) {
      if (t.currentOrderId == null) return const Text('—');
      return InkWell(
        onTap: () => admin ? context.push('/orders/${t.currentOrderId}') : _openPos(context, t),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Wrap(alignment: end ? WrapAlignment.end : WrapAlignment.start, spacing: 6, children: [
            Text(t.currentOrderCode ?? '#${t.currentOrderId}',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 13, color: Palette.navyAccent)),
            Text(money(t.currentOrderTotal), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
          ]),
        ),
      );
    }

    final desc = Text(
      '$activeCount bàn đang dùng · $serving bàn có khách. Trạng thái bàn do máy POS cập nhật khi mở và thanh toán đơn.',
      style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
    );
    const emptyText = 'Chưa có bàn nào. Bấm “Thêm bàn” để bắt đầu.';

    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= kTableBreakpoint;
      final add = FilledButton(onPressed: () => _openForm(context, ref), child: const Text('+ Thêm bàn'));
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          PageWidth(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (admin && c.maxWidth >= kSheetBreakpoint)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: desc), const SizedBox(width: 16), add])
              else ...[
                desc,
                if (admin) ...[const SizedBox(height: 12), add],
              ],
              const SizedBox(height: 20),
              if (wide)
                WideTable(
                  columns: const [
                    WideColumn('Bàn', flex: 3),
                    WideColumn('Sức chứa', flex: 2),
                    WideColumn('Trạng thái', flex: 2),
                    WideColumn('Đơn hiện tại', flex: 3),
                    WideColumn('', flex: 3, end: true),
                  ],
                  empty: const EmptyState(text: emptyText, icon: Icons.table_restaurant_outlined),
                  rows: [
                    for (final t in tables)
                      WideRow(
                        dimmed: !t.isActive,
                        onTap: t.isActive ? () => _openPos(context, t) : null,
                        cells: [
                          _TableTitle(table: t),
                          _Capacity(t.capacity),
                          _TableStatus(table: t),
                          orderCell(t, end: false),
                          Wrap(alignment: WrapAlignment.end, children: actions(t)),
                        ],
                      ),
                  ],
                )
              else if (tables.isEmpty)
                const Card(child: EmptyState(text: emptyText, icon: Icons.table_restaurant_outlined))
              else
                CardGrid(children: [
                  for (final t in tables)
                    RowCard(
                      dimmed: !t.isActive,
                      onTap: t.isActive ? () => _openPos(context, t) : null,
                      title: _TableTitle(table: t),
                      fields: [
                        ('Sức chứa', _Capacity(t.capacity)),
                        ('Trạng thái', _TableStatus(table: t)),
                        ('Đơn hiện tại', orderCell(t, end: true)),
                      ],
                      actions: actions(t),
                    ),
                ]),
            ]),
          ),
        ],
      );
    });
  }
}

class _TableTitle extends StatelessWidget {
  const _TableTitle({required this.table});
  final DiningTable table;

  @override
  Widget build(BuildContext context) {
    return Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, children: [
      Text(table.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15.5)),
      Text(table.code, style: TextStyle(fontFamily: 'monospace', fontSize: 12, color: context.co.muted)),
    ]);
  }
}

class _Capacity extends StatelessWidget {
  const _Capacity(this.capacity);
  final int capacity;

  @override
  Widget build(BuildContext context) => Text('$capacity chỗ', style: const TextStyle(fontFeatures: tabular));
}

/// 'Ngừng sử dụng' (neutral) / 'Có khách' (warn) / 'Trống' (good), same rule as tables.ejs.
class _TableStatus extends StatelessWidget {
  const _TableStatus({required this.table});
  final DiningTable table;

  @override
  Widget build(BuildContext context) {
    if (!table.isActive) return const StatusBadge('Ngừng sử dụng', tone: Tone.neutral);
    if (table.status == 'serving') return const StatusBadge('Có khách', tone: Tone.warn);
    return const StatusBadge('Trống', tone: Tone.good);
  }
}
