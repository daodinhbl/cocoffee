import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_shell.dart' show kSidebarBreakpoint;
import '../../core/widgets/common.dart';
import 'dashboard_models.dart';
import 'dashboard_providers.dart';
import 'widgets/header_actions.dart';
import 'widgets/hourly_chart.dart';
import 'widgets/rank_chart.dart';

/// "Tổng quan" (views/pages/dashboard.ejs): hero with today's revenue and quick actions, KPI cards, revenue by
/// hour, recent orders, low stock, then the four "Phân tích nhanh" rankings. Header: Zalo status + bell.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final isAdmin = user?.isAdmin ?? false;
    final wide = MediaQuery.sizeOf(context).width >= kSidebarBreakpoint;
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: wide ? null : const _BrandMark(),
        title: const Text('Tổng quan'),
        actions: [
          const ZaloStatusPill(),
          if (isAdmin) const NotificationsBell(),
          const SizedBox(width: 8),
        ],
      ),
      body: isAdmin ? const _AdminBody() : _CashierBody(name: user?.fullName ?? ''),
    );
  }
}

/// Phones only (the sidebar shows the brand from 840 dp), like the web header's brand mark.
class _BrandMark extends ConsumerWidget {
  const _BrandMark();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Center(
      child: Container(
        width: 36,
        height: 36,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: const Color(0xFFE9D3B6)),
        ),
        child: Image.asset('assets/brand/mark.png', fit: BoxFit.contain),
      ),
    );
  }
}

class _AdminBody extends ConsumerWidget {
  const _AdminBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(dashboardProvider);
    return RefreshIndicator(
      onRefresh: () {
        ref.invalidate(notificationsProvider);
        ref.invalidate(zaloStatusProvider);
        // A failure is shown by AsyncBody with a retry button.
        return ref.refresh(dashboardProvider.future).then((_) {}, onError: (Object _) {});
      },
      child: LayoutBuilder(builder: (context, c) {
        final pad = c.maxWidth < 600 ? 16.0 : 24.0;
        final contentWidth = math.min(c.maxWidth - 2 * pad, 1280.0);
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.fromLTRB(pad, pad, pad, 32),
          children: [
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1280),
                child: AsyncBody<DashboardData>(
                  value: async,
                  onRetry: () => ref.invalidate(dashboardProvider),
                  data: (d) => _DashboardContent(data: d, width: contentWidth),
                ),
              ),
            ),
          ],
        );
      }),
    );
  }
}

class _DashboardContent extends ConsumerWidget {
  const _DashboardContent({required this.data, required this.width});
  final DashboardData data;
  final double width;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final gap = width < 600 ? 16.0 : 24.0;
    final sideBySide = width >= 1000;
    final recent = _RecentOrders(orders: data.recentOrders);
    final low = _LowStock(data: data);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _Hero(data: data, name: user?.fullName ?? '', width: width),
      SizedBox(height: gap),
      _KpiGrid(data: data, columns: width >= 1000 ? 4 : 2, gap: width < 600 ? 12 : 20),
      SizedBox(height: gap),
      // The web wraps the "06:00 – 22:00" note under the title when the row is narrow.
      SectionCard(
        title: 'Doanh thu theo giờ',
        subtitle: width < 600 ? '06:00 – 22:00 · hôm nay' : null,
        trailing: width < 600
            ? null
            : Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text('06:00 – 22:00 · hôm nay', style: context.tt.bodySmall),
              ),
        child: HourlyChart(hours: data.hourly, nowHour: shopNow().hour),
      ),
      SizedBox(height: gap),
      if (sideBySide)
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(flex: 7, child: recent),
          SizedBox(width: gap),
          Expanded(flex: 5, child: low),
        ])
      else ...[
        recent,
        SizedBox(height: gap),
        low,
      ],
      const SizedBox(height: 32),
      Text('Phân tích nhanh', style: context.tt.titleLarge?.copyWith(fontSize: 19)),
      const SizedBox(height: 12),
      _QuickCharts(data: data, columns: width >= 840 ? 2 : 1, gap: gap),
    ]);
  }
}

// ---------------------------------------------------------------- hero

const _emerald300 = Color(0xFF6EE7B7);
const _amber300 = Color(0xFFFCD34D);

class _Hero extends StatelessWidget {
  const _Hero({required this.data, required this.name, required this.width});
  final DashboardData data;
  final String name;
  final double width;

  @override
  Widget build(BuildContext context) {
    final compact = width < 600;
    final now = shopNow();
    final (deltaText, deltaTone) = revenueDelta(data.today.revenue, data.yesterday.revenue);
    final deltaColor = switch (deltaTone) {
      Tone.good => _emerald300,
      Tone.warn => _amber300,
      _ => Palette.navyMuted,
    };
    final info = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text('${greeting(now.hour)}${name.isEmpty ? '' : ', $name'} · ${longShopDate()}',
          style: const TextStyle(color: Palette.navySoft, fontSize: 14, height: 1.35)),
      const SizedBox(height: 6),
      const Text('DOANH THU HÔM NAY',
          style: TextStyle(color: Palette.navyMuted, fontSize: 13.5, fontWeight: FontWeight.w600, letterSpacing: 1.1, height: 1.3)),
      const SizedBox(height: 4),
      FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Text(money(data.today.revenue),
            key: const ValueKey('hero-revenue'),
            style: TextStyle(
                color: Colors.white, fontSize: compact ? 36 : 48, fontWeight: FontWeight.w700, fontFeatures: tabular, height: 1.15)),
      ),
      const SizedBox(height: 8),
      Text(deltaText, style: TextStyle(color: deltaColor, fontSize: 14, height: 1.3)),
      const SizedBox(height: 4),
      Text('${data.today.orders} đơn hoàn tất · cập nhật lúc ${shopTime(data.fetchedAt)}',
          style: const TextStyle(color: Palette.navyMuted, fontSize: 12.5, height: 1.3)),
    ]);
    final actions = [
      _HeroAction(icon: Icons.shopping_cart_outlined, label: 'Mở POS', primary: true, compact: compact, onTap: () => context.push('/pos')),
      _HeroAction(icon: Icons.receipt_long_outlined, label: 'Đơn hàng', compact: compact, onTap: () => context.go('/orders')),
      _HeroAction(icon: Icons.bar_chart_rounded, label: 'Báo cáo', compact: compact, onTap: () => context.go('/reports')),
    ];
    final Widget body;
    if (compact) {
      body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        info,
        const SizedBox(height: 20),
        Row(children: [
          for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(width: 8), Expanded(child: actions[i])],
        ]),
      ]);
    } else if (width < 900) {
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        info,
        const SizedBox(height: 20),
        Wrap(spacing: 8, runSpacing: 8, children: actions),
      ]);
    } else {
      body = Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(child: info),
        const SizedBox(width: 24),
        Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(width: 8), actions[i]],
        ]),
      ]);
    }
    return Semantics(
      container: true,
      label: 'Hôm nay',
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Palette.navyDarker,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [BoxShadow(color: Palette.navyDarker.withValues(alpha: 0.45), blurRadius: 32, offset: const Offset(0, 12), spreadRadius: -12)],
        ),
        child: Stack(children: [
          Positioned(right: -64, top: -64, child: _Glow(size: 224, color: Palette.navyAccent.withValues(alpha: 0.30))),
          Positioned(bottom: -80, left: width / 3, child: _Glow(size: 192, color: Palette.amber.withValues(alpha: 0.10))),
          Padding(padding: EdgeInsets.all(compact ? 20 : 28), child: body),
        ]),
      ),
    );
  }
}

class _Glow extends StatelessWidget {
  const _Glow({required this.size, required this.color});
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)])),
      ),
    );
  }
}

class _HeroAction extends StatelessWidget {
  const _HeroAction({required this.icon, required this.label, required this.onTap, required this.compact, this.primary = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool compact;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final fg = primary ? Palette.navyDarker : Colors.white;
    final style = TextStyle(
        color: fg, fontSize: compact ? 12.5 : 14, fontWeight: primary ? FontWeight.w700 : FontWeight.w600, height: 1.2);
    return Material(
      color: primary ? Palette.amber : Colors.white.withValues(alpha: 0.10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: primary ? BorderSide.none : BorderSide(color: Colors.white.withValues(alpha: 0.15)),
      ),
      child: InkWell(
        customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        onTap: onTap,
        child: SizedBox(
          height: compact ? 64 : 48,
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 16),
            child: compact
                ? Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Icon(icon, size: 20, color: fg),
                    const SizedBox(height: 4),
                    Text(label, style: style, maxLines: 1, overflow: TextOverflow.ellipsis),
                  ])
                : Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(icon, size: 20, color: fg),
                    const SizedBox(width: 8),
                    Text(label, style: style),
                  ]),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- KPI cards

class _KpiGrid extends StatelessWidget {
  const _KpiGrid({required this.data, required this.columns, required this.gap});
  final DashboardData data;
  final int columns;
  final double gap;

  Widget _sub(BuildContext context, String text, Tone tone) => Text(
        text,
        style: context.tt.bodySmall?.copyWith(
          color: switch (tone) {
            Tone.good => context.co.good,
            Tone.warn => context.co.warn,
            _ => context.co.muted,
          },
        ),
      );

  @override
  Widget build(BuildContext context) {
    final cur = data.today;
    final c = data.counts;
    final hasRevenue = cur.revenue > 0;
    final cards = <Widget>[
      StatCard(
        label: 'Giá vốn (COGS)',
        icon: Icons.inventory_2_outlined,
        value: money(cur.cogs),
        footer: _sub(context, hasRevenue ? '${pct(cur.cogs / cur.revenue * 100)} doanh thu' : 'Chưa có đơn hoàn tất', Tone.neutral),
      ),
      StatCard(
        label: 'Lãi gộp',
        icon: Icons.check_rounded,
        tone: Tone.good,
        value: money(cur.grossProfit),
        footer: _sub(context, hasRevenue ? '${pct(data.margin)} biên lợi nhuận' : '—',
            hasRevenue && data.margin >= 55 ? Tone.good : Tone.neutral),
      ),
      StatCard(
        label: 'Đơn chờ thu',
        icon: Icons.receipt_long_outlined,
        tone: Tone.warn,
        value: '${c.unpaid}',
        onTap: () => context.go('/orders?status=completed&payment=unpaid'),
        footer: _sub(context, '${c.drafts} đơn Zalo chờ khách xác nhận · ${c.openOrders} đang phục vụ',
            c.unpaid > 0 ? Tone.warn : Tone.neutral),
      ),
      StatCard(
        label: 'Đang phục vụ',
        icon: Icons.table_restaurant_outlined,
        tone: Tone.info,
        value: '${c.openOrders} đơn',
        onTap: () => context.push('/tables'),
        footer: Text('Xem sơ đồ bàn →',
            style: context.tt.bodySmall?.copyWith(color: Palette.navyAccent, fontWeight: FontWeight.w600)),
      ),
    ];
    return Column(children: [
      for (var r = 0; r < cards.length; r += columns) ...[
        if (r > 0) SizedBox(height: gap),
        IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = r; i < r + columns; i++) ...[
              if (i > r) SizedBox(width: gap),
              Expanded(child: i < cards.length ? cards[i] : const SizedBox.shrink()),
            ],
          ]),
        ),
      ],
    ]);
  }
}

// ---------------------------------------------------------------- recent orders

class _RecentOrders extends StatelessWidget {
  const _RecentOrders({required this.orders});
  final List<RecentOrder> orders;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Đơn gần đây',
      trailing: _HeaderLink(label: 'Tất cả đơn →', onTap: () => context.go('/orders')),
      child: orders.isEmpty
          ? Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Center(
                  child: Text('Chưa có đơn hàng nào.', style: context.tt.bodyMedium?.copyWith(color: context.co.muted))),
            )
          : LayoutBuilder(builder: (context, c) {
              if (c.maxWidth >= 520) return _OrdersTable(orders: orders);
              final cols = math.max(1, ((c.maxWidth + 12) / (280 + 12)).floor());
              final w = (c.maxWidth - 12 * (cols - 1)) / cols;
              return Wrap(spacing: 12, runSpacing: 12, children: [
                for (final o in orders) SizedBox(width: w, child: _OrderCard(order: o)),
              ]);
            }),
    );
  }
}

class _HeaderLink extends StatelessWidget {
  const _HeaderLink({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
          visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8), minimumSize: const Size(0, 36)),
      child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
    );
  }
}

const _codeStyle = TextStyle(color: Palette.navyAccent, fontWeight: FontWeight.w600, fontSize: 14, fontFeatures: tabular, height: 1.3);

class _OrdersTable extends StatelessWidget {
  const _OrdersTable({required this.orders});
  final List<RecentOrder> orders;

  @override
  Widget build(BuildContext context) {
    final head = context.tt.labelSmall;
    Widget cell(Widget child, {int flex = 1, Alignment align = Alignment.centerLeft}) =>
        Expanded(flex: flex, child: Align(alignment: align, child: child));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(color: context.cs.surfaceContainerLow, border: Border(bottom: BorderSide(color: context.co.line))),
        child: Row(children: [
          cell(Text('MÃ ĐƠN', style: head), flex: 5),
          cell(Text('KÊNH', style: head), flex: 2),
          cell(Text('TỔNG TIỀN', style: head), flex: 3, align: Alignment.centerRight),
          const SizedBox(width: 16),
          cell(Text('TRẠNG THÁI', style: head), flex: 3),
        ]),
      ),
      for (var i = 0; i < orders.length; i++)
        InkWell(
          onTap: () => context.push('/orders/${orders[i].id}'),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            decoration: BoxDecoration(
                border: i == orders.length - 1 ? null : Border(bottom: BorderSide(color: context.co.line))),
            child: Row(children: [
              cell(
                Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, children: [
                  Text(orders[i].orderCode, style: _codeStyle),
                  Text(shopTime(orders[i].createdAt), style: context.tt.bodySmall),
                ]),
                flex: 5,
              ),
              cell(StatusBadge(orders[i].sourceBadge.$1, tone: orders[i].sourceBadge.$2, dense: true), flex: 2),
              cell(
                Text(money(orders[i].total), style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: tabular)),
                flex: 3,
                align: Alignment.centerRight,
              ),
              const SizedBox(width: 16),
              cell(StatusBadge(orders[i].statusLabel.$1, tone: orders[i].statusLabel.$2, dense: true), flex: 3),
            ]),
          ),
        ),
    ]);
  }
}

/// Phone: each row is a card (web .rtable): title = code + time, then Kênh / Tổng tiền / Trạng thái.
class _OrderCard extends StatelessWidget {
  const _OrderCard({required this.order});
  final RecentOrder order;

  @override
  Widget build(BuildContext context) {
    Widget line(String label, Widget value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 7),
          child: Row(children: [
            Text(label.toUpperCase(), style: context.tt.labelSmall),
            const SizedBox(width: 12),
            Expanded(child: Align(alignment: Alignment.centerRight, child: value)),
          ]),
        );
    return Material(
      color: context.cs.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: context.co.line)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.push('/orders/${order.id}'),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, children: [
              Text(order.orderCode, style: _codeStyle),
              Text(shopTime(order.createdAt), style: context.tt.bodySmall),
            ]),
            const SizedBox(height: 4),
            line('Kênh', StatusBadge(order.sourceBadge.$1, tone: order.sourceBadge.$2, dense: true)),
            const Divider(),
            line('Tổng tiền', Text(money(order.total), style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: tabular))),
            const Divider(),
            line('Trạng thái', StatusBadge(order.statusLabel.$1, tone: order.statusLabel.$2, dense: true)),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- low stock

class _LowStock extends ConsumerWidget {
  const _LowStock({required this.data});
  final DashboardData data;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = data.lowStock;
    // low_stock is capped at 8 by the API; the bell's list (same source, uncapped) gives the real count.
    final notes = ref.watch(notificationsProvider);
    final count = data.lowStockCount ??
        (notes.hasValue ? math.max(notes.requireValue.lowStock.length, items.length) : items.length);
    return SectionCard(
      title: 'Cảnh báo tồn kho thấp',
      trailing: count > 0
          ? Material(
              color: context.co.warnTint,
              shape: StadiumBorder(side: BorderSide(color: context.co.warn.withValues(alpha: 0.3))),
              child: InkWell(
                customBorder: const StadiumBorder(),
                onTap: () => context.go('/inventory?low=1'),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  child: Text('$count mục',
                      style: TextStyle(color: context.co.warn, fontWeight: FontWeight.w700, fontSize: 12.5, fontFeatures: tabular)),
                ),
              ),
            )
          : null,
      child: items.isEmpty
          ? Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Column(children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(color: context.co.goodTint, shape: BoxShape.circle),
                  child: Icon(Icons.check_rounded, color: context.co.good),
                ),
                const SizedBox(height: 12),
                Text('Mọi nguyên liệu đều trên mức tối thiểu.',
                    textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
              ]),
            )
          : Column(children: [
              for (var i = 0; i < items.length; i++) ...[
                if (i > 0) const Divider(),
                _LowStockRow(item: items[i]),
              ],
            ]),
    );
  }
}

class _LowStockRow extends StatelessWidget {
  const _LowStockRow({required this.item});
  final LowStockItem item;

  @override
  Widget build(BuildContext context) {
    final p = item.barPercent;
    return Tooltip(
      message: 'Nhập kho',
      child: InkWell(
        onTap: () => context.push('/receiving?item=${item.id}'),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(
                child: Text(item.name,
                    style: const TextStyle(color: Palette.navyAccent, fontWeight: FontWeight.w600, fontSize: 14.5, height: 1.3)),
              ),
              const SizedBox(width: 12),
              Text('${qty(item.quantity)} / ${qty(item.minStock)} ${item.unit}',
                  style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
            ]),
            const SizedBox(height: 8),
            Semantics(
              label: 'Tồn kho bằng $p% mức tối thiểu',
              child: LevelBar(fraction: p / 100, color: p < 60 ? const Color(0xFFEF4444) : Palette.amber),
            ),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- Phân tích nhanh

class _QuickCharts extends StatelessWidget {
  const _QuickCharts({required this.data, required this.columns, required this.gap});
  final DashboardData data;
  final int columns;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final charts = <Widget>[
      RankChart(
        title: 'Món bán chạy',
        subtitle: '30 ngày gần nhất · theo số ly/món bán ra',
        linkLabel: 'Báo cáo',
        onLink: () => context.go('/reports'),
        empty: 'Chưa có đơn hoàn tất trong 30 ngày.',
        rows: [
          for (final p in data.bestSellers.take(8))
            RankRow(
              label: p.name,
              value: p.qty,
              display: '${qty(p.qty)} món',
              detail: '${qty(p.qty)} món · doanh thu ${money(p.revenue)}',
            ),
        ],
      ),
      RankChart(
        title: 'Hàng sắp hết',
        subtitle: 'Tồn kho so với mức tối thiểu · thấp nhất trước',
        linkLabel: 'Nhập kho',
        onLink: () => context.go('/inventory?low=1'),
        empty: 'Không có nguyên liệu nào dưới mức tối thiểu.',
        rows: [
          for (final i in data.lowStock.take(8))
            RankRow(
              label: i.name,
              value: (i.ratio * 100).round(),
              display: '${(i.ratio * 100).round()}%',
              tone: i.ratio < 0.5 ? RankTone.critical : RankTone.warning,
              detail: 'còn ${qty(i.quantity)} / tối thiểu ${qty(i.minStock)} ${i.unit}',
              onTap: () => context.push('/receiving?item=${i.id}'),
            ),
        ],
      ),
      RankChart(
        title: 'Nguyên liệu tồn kho nhiều',
        subtitle: 'Giá trị tồn (số lượng × giá vốn bình quân)',
        linkLabel: 'Kho',
        onLink: () => context.go('/inventory'),
        empty: 'Chưa có giá trị tồn kho.',
        rows: [
          for (final i in data.overstock.take(8))
            RankRow(
              label: i.name,
              value: i.value,
              display: money(i.value),
              detail: '${qty(i.qty)} ${i.unit}${i.cover != null && i.cover != 0 ? ' · gấp ${qty((i.cover! * 10).round() / 10)} lần mức tối thiểu' : ''}',
              onTap: () => context.push('/inventory/${i.id}'),
            ),
        ],
      ),
      RankChart(
        title: 'Khách hàng công nợ nhiều nhất',
        subtitle: 'Đơn Zalo đã giao nhưng chưa thu tiền',
        linkLabel: 'Đơn chờ thu',
        onLink: () => context.go('/orders?status=completed&payment=unpaid'),
        empty: 'Không có khách nào đang nợ.',
        rows: [
          for (final d in data.debtors)
            RankRow(
              label: d.who,
              value: d.amount,
              display: money(d.amount),
              detail: '${d.orders} đơn chưa thu${d.oldest != null ? ' · cũ nhất ${shopTime(d.oldest)}' : ''}',
            ),
        ],
      ),
    ];
    if (columns == 1) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (var i = 0; i < charts.length; i++) ...[if (i > 0) SizedBox(height: gap), charts[i]],
      ]);
    }
    return Column(children: [
      for (var r = 0; r < charts.length; r += 2) ...[
        if (r > 0) SizedBox(height: gap),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: charts[r]),
          SizedBox(width: gap),
          Expanded(child: r + 1 < charts.length ? charts[r + 1] : const SizedBox.shrink()),
        ]),
      ],
    ]);
  }
}

// ---------------------------------------------------------------- cashier

/// The web sends cashiers to the POS; in the app they land here, so show the shortcuts without the
/// admin-only numbers (GET /api/admin/dashboard answers 403 for a cashier).
class _CashierBody extends StatelessWidget {
  const _CashierBody({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    final now = shopNow();
    return LayoutBuilder(builder: (context, c) {
      final compact = c.maxWidth < 600;
      final actions = [
        _HeroAction(icon: Icons.shopping_cart_outlined, label: 'Mở POS', primary: true, compact: compact, onTap: () => context.push('/pos')),
        _HeroAction(icon: Icons.table_restaurant_outlined, label: 'Bàn', compact: compact, onTap: () => context.push('/tables')),
        _HeroAction(icon: Icons.receipt_long_outlined, label: 'Đơn hàng', compact: compact, onTap: () => context.go('/orders')),
      ];
      return ListView(padding: EdgeInsets.all(compact ? 16 : 24), children: [
        Container(
          padding: EdgeInsets.all(compact ? 20 : 28),
          decoration: BoxDecoration(color: Palette.navyDarker, borderRadius: BorderRadius.circular(16)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${greeting(now.hour)}${name.isEmpty ? '' : ', $name'} · ${longShopDate()}',
                style: const TextStyle(color: Palette.navySoft, fontSize: 14, height: 1.35)),
            const SizedBox(height: 8),
            const Text('Tổng quan doanh thu chỉ dành cho quản trị viên.',
                style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600, height: 1.35)),
            const SizedBox(height: 20),
            Row(children: [
              for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(width: 8), Expanded(child: actions[i])],
            ]),
          ]),
        ),
      ]);
    });
  }
}
