import 'package:flutter/material.dart';

import '../../../core/format.dart';
import '../../../core/theme/app_theme.dart';
import '../pos_models.dart';

/// Table map ('Chọn bàn' of the web POS): legend, the 'Mang đi' tile, then every active table coloured by status.
/// Tap a free table = order for it; tap a serving table = open its current order.
class TableMap extends StatelessWidget {
  const TableMap({super.key, required this.data, required this.selectedTableId, required this.takeawaySelected, required this.onPick, required this.onRefresh});
  final PosData data;
  final int? selectedTableId;
  final bool takeawaySelected;
  final ValueChanged<PosTable?> onPick;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final serving = data.tables.where((t) => t.busy).length;
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: CustomScrollView(slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
          sliver: SliverToBoxAdapter(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text('Chọn bàn', style: context.tt.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: Palette.navyDarker)),
                ),
                Flexible(
                  child: Text('$serving/${data.tables.length} bàn có khách',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall),
                ),
              ]),
              const SizedBox(height: 6),
              Wrap(spacing: 16, runSpacing: 4, children: [
                _Legend(color: context.co.good, label: 'Trống'),
                _Legend(color: context.co.bad, label: 'Đang phục vụ (chạm để mở đơn)'),
                if (data.tables.any((t) => t.heldLocally)) _Legend(color: context.co.warn, label: 'Giữ đơn khi mất mạng (chờ đồng bộ)'),
              ]),
            ]),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 24),
          sliver: SliverGrid(
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 150,
              mainAxisExtent: 132,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
            ),
            delegate: SliverChildListDelegate([
              _TableTile(
                name: 'Mang đi',
                sub: 'Không dùng bàn',
                icon: Icons.shopping_bag_outlined,
                fg: context.co.warn,
                bg: context.co.warnTint,
                selected: takeawaySelected,
                onTap: () => onPick(null),
              ),
              for (final t in data.tables)
                _TableTile(
                  name: t.label,
                  sub: t.heldLocally ? 'Chờ đồng bộ' : (t.busy ? 'Đang phục vụ' : 'Trống'),
                  amount: t.busy && t.currentOrderTotal != null ? money(t.currentOrderTotal) : null,
                  icon: t.heldLocally ? Icons.cloud_upload_outlined : Icons.table_restaurant_rounded,
                  fg: t.heldLocally ? context.co.warn : (t.busy ? context.co.bad : context.co.good),
                  bg: t.heldLocally ? context.co.warnTint : (t.busy ? context.co.badTint : context.co.goodTint),
                  selected: selectedTableId == t.id,
                  onTap: () => onPick(t),
                ),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.color, required this.label});
  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(width: 12, height: 12, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
      const SizedBox(width: 6),
      Flexible(child: Text(label, style: context.tt.bodySmall?.copyWith(color: context.co.neutral))),
    ]);
  }
}

class _TableTile extends StatelessWidget {
  const _TableTile({required this.name, required this.sub, this.amount, required this.icon, required this.fg, required this.bg, required this.selected, required this.onTap});
  final String name;
  final String sub;
  final String? amount;
  final IconData icon;
  final Color fg;
  final Color bg;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: selected ? Palette.navyAccent : fg.withValues(alpha: 0.35), width: selected ? 3 : 2),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Stack(children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(icon, size: 34, color: fg),
                const SizedBox(height: 4),
                Text(name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: fg, height: 1.25)),
                Text(sub,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12.5, color: fg, height: 1.3)),
                if (amount != null)
                  Text(amount!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: fg, fontFeatures: tabular, height: 1.3)),
              ]),
            ),
            if (selected)
              Positioned(
                right: 6,
                top: 6,
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: const BoxDecoration(color: Palette.navyAccent, shape: BoxShape.circle),
                  child: const Icon(Icons.check_rounded, size: 16, color: Colors.white),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}
