import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'report_bar_chart.dart';
import 'report_models.dart';
import 'report_providers.dart';

/// Content width from which the report uses the web's xl layout (4 KPI columns, 7/5 card grid).
const _kWide = 840.0;

/// "Báo cáo" (Web Admin views/pages/reports.ejs): completed orders over a period — presets and a custom range,
/// four KPI cards, revenue by day (chart + table), top products, revenue by hour, channels and payment methods.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(reportProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Báo cáo'),
        actions: [
          IconButton(
            tooltip: 'Tải lại',
            onPressed: () => ref.invalidate(reportProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(2),
          child: report.isLoading && report.hasValue ? const LinearProgressIndicator(minHeight: 2) : const SizedBox(height: 2),
        ),
      ),
      body: AsyncBody<ReportData>(
        value: report,
        onRetry: () => ref.invalidate(reportProvider),
        data: (r) => RefreshIndicator(
          onRefresh: () => ref.refresh(reportProvider.future),
          child: _ReportView(report: r),
        ),
      ),
    );
  }
}

class _ReportView extends StatelessWidget {
  const _ReportView({required this.report});
  final ReportData report;

  @override
  Widget build(BuildContext context) {
    final r = report;
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= _kWide;
      final gap = wide ? 20.0 : 14.0;
      final day = _DayCard(report: r);
      final top = _TopProductsCard(report: r);
      final hour = _HourCard(report: r);
      final channels = _ChannelsCard(report: r);
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(16, 14, 16, wide ? 32 : 24),
        children: [
          Text(
            'Đơn đã hoàn tất · ${rangeText(r.from, r.to)}. Doanh thu tính theo ngày hoàn tất đơn (kể cả đơn Zalo chưa thu tiền).',
            style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
          ),
          if (r.clamped) ...[const SizedBox(height: 12), const _ClampNotice()],
          const SizedBox(height: 16),
          _RangeControls(report: r),
          const SizedBox(height: 16),
          _KpiGrid(report: r, columns: wide ? 4 : 2, gap: wide ? 16 : 12, wide: wide),
          SizedBox(height: gap),
          if (wide) ...[
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 7, child: day),
              SizedBox(width: gap),
              Expanded(flex: 5, child: top),
            ]),
            SizedBox(height: gap),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 7, child: hour),
              SizedBox(width: gap),
              Expanded(flex: 5, child: channels),
            ]),
          ] else ...[
            day,
            SizedBox(height: gap),
            top,
            SizedBox(height: gap),
            hour,
            SizedBox(height: gap),
            channels,
          ],
        ],
      );
    });
  }
}

/// Amber notice of the web (role="status") when the asked range was longer than 366 days.
class _ClampNotice extends StatelessWidget {
  const _ClampNotice();

  @override
  Widget build(BuildContext context) {
    final co = context.co;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: co.warnTint,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: co.warn.withValues(alpha: 0.35)),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.info_outline_rounded, size: 20, color: co.warn),
          const SizedBox(width: 10),
          Expanded(
            child: Text('Khoảng thời gian tối đa là 366 ngày; đang hiển thị 7 ngày gần nhất.',
                style: TextStyle(color: co.warn, fontSize: 14, height: 1.4)),
          ),
        ]),
      ),
    );
  }
}

/// Preset chips ("Khoảng thời gian nhanh") and the custom range form (Từ ngày, Đến ngày, Xem).
class _RangeControls extends ConsumerStatefulWidget {
  const _RangeControls({required this.report});
  final ReportData report;

  @override
  ConsumerState<_RangeControls> createState() => _RangeControlsState();
}

class _RangeControlsState extends ConsumerState<_RangeControls> {
  late String _from = widget.report.from;
  late String _to = widget.report.to;

  @override
  void didUpdateWidget(covariant _RangeControls old) {
    super.didUpdateWidget(old);
    if (old.report.from != widget.report.from || old.report.to != widget.report.to) {
      _from = widget.report.from;
      _to = widget.report.to;
    }
  }

  void _apply(String from, String to) {
    final changed = ref.read(reportRangeProvider.notifier).select(from, to);
    if (!changed) ref.invalidate(reportProvider);
  }

  Future<void> _pick({required bool from}) async {
    // Last pickable day: the shop's today, or the server's range end if the phone clock is behind.
    final today = parseDayKey(shopToday()) ?? DateTime.now();
    final serverTo = parseDayKey(widget.report.to);
    final last = serverTo != null && serverTo.isAfter(today) ? serverTo : today;
    final first = DateTime(2020);
    var initial = parseDayKey(from ? _from : _to) ?? last;
    if (initial.isAfter(last)) initial = last;
    if (initial.isBefore(first)) initial = first;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: first,
      lastDate: last,
      helpText: from ? 'Từ ngày' : 'Đến ngày',
      cancelText: 'Hủy',
      confirmText: 'Chọn',
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (from) {
        _from = isoDay(picked);
      } else {
        _to = isoDay(picked);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.report;
    final presets = Semantics(
      container: true,
      label: 'Khoảng thời gian nhanh',
      child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (final p in r.presets) _PresetChip(label: p.label, active: r.isActive(p), onTap: () => _apply(p.from, p.to)),
      ]),
    );
    final fromField = _DateField(key: const Key('report-from'), label: 'Từ ngày', day: _from, onTap: () => _pick(from: true));
    final toField = _DateField(key: const Key('report-to'), label: 'Đến ngày', day: _to, onTap: () => _pick(from: false));
    final view = FilledButton(onPressed: () => _apply(_from, _to), child: const Text('Xem'));

    return LayoutBuilder(builder: (context, c) {
      if (c.maxWidth < 600) {
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          presets,
          const SizedBox(height: 14),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(child: fromField),
            const SizedBox(width: 8),
            Expanded(child: toField),
            const SizedBox(width: 8),
            view,
          ]),
        ]);
      }
      return Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.end,
        spacing: 16,
        runSpacing: 14,
        children: [
          presets,
          Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
            SizedBox(width: 164, child: fromField),
            const SizedBox(width: 8),
            SizedBox(width: 164, child: toField),
            const SizedBox(width: 8),
            view,
          ]),
        ],
      );
    });
  }
}

/// Quick range chip like the web's (radius 4, blue-50 + navy text when active).
class _PresetChip extends StatelessWidget {
  const _PresetChip({required this.label, required this.active, required this.onTap});
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final light = Theme.of(context).brightness == Brightness.light;
    final accent = light ? Palette.navyAccent : context.cs.primary;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(6),
      side: BorderSide(color: active ? accent : context.cs.outline),
    );
    return Semantics(
      button: true,
      selected: active,
      child: Material(
        color: active ? context.co.infoTint : context.cs.surface,
        shape: shape,
        child: InkWell(
          customBorder: shape,
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 40),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Center(
                widthFactor: 1,
                child: Text(label,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                      color: active ? (light ? Palette.navy : context.cs.primary) : context.cs.onSurface,
                    )),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Read-only field that opens the date picker; label above like the web form.
class _DateField extends StatelessWidget {
  const _DateField({super.key, required this.label, required this.day, required this.onTap});
  final String label;
  final String day;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(label, style: context.tt.bodySmall),
      const SizedBox(height: 4),
      Semantics(
        button: true,
        label: '$label ${dayFull(day)}',
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: InputDecorator(
            decoration: const InputDecoration(
              contentPadding: EdgeInsets.fromLTRB(12, 13, 0, 13),
              suffixIcon: Icon(Icons.calendar_today_outlined, size: 18),
              suffixIconConstraints: BoxConstraints(minWidth: 34, minHeight: 20),
            ),
            child: Text(dayFull(day), maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: const TextStyle(fontFeatures: tabular)),
          ),
        ),
      ),
    ]);
  }
}

/// "Chỉ số chính": 2 columns on phones, 4 from the xl layout (same as the web grid).
class _KpiGrid extends StatelessWidget {
  const _KpiGrid({required this.report, required this.columns, required this.gap, required this.wide});
  final ReportData report;
  final int columns;
  final double gap;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    final s = report.summary;
    final tiles = [
      _KpiTile(label: 'Doanh thu', value: money(s.revenue), sub: '${s.orders} đơn · TB ${money(report.avgTicket)}/đơn', wide: wide),
      _KpiTile(
        label: 'Giá vốn (COGS)',
        value: money(s.cogs),
        sub: s.revenue > 0 ? '${pct(s.cogs / s.revenue * 100)} doanh thu' : '—',
        wide: wide,
      ),
      _KpiTile(label: 'Lãi gộp', value: money(s.grossProfit), sub: s.revenue > 0 ? '${pct(report.margin)} biên lợi nhuận' : '—', wide: wide),
      _KpiTile(label: 'Chưa thu tiền', value: money(s.unpaid), sub: 'Đơn Zalo đã hoàn tất, chờ thu', wide: wide),
    ];
    final rows = <Widget>[];
    for (var i = 0; i < tiles.length; i += columns) {
      final row = tiles.sublist(i, math.min(i + columns, tiles.length));
      rows.add(IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (var j = 0; j < row.length; j++) ...[if (j > 0) SizedBox(width: gap), Expanded(child: row[j])],
        ]),
      ));
    }
    return Semantics(
      container: true,
      label: 'Chỉ số chính',
      child: Column(children: [
        for (var i = 0; i < rows.length; i++) ...[if (i > 0) SizedBox(height: gap), rows[i]],
      ]),
    );
  }
}

class _KpiTile extends StatelessWidget {
  const _KpiTile({required this.label, required this.value, required this.sub, required this.wide});
  final String label, value, sub;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: EdgeInsets.all(wide ? 18 : 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(label.toUpperCase(), style: context.tt.labelSmall, maxLines: 2),
          SizedBox(height: wide ? 10 : 8),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(value,
                maxLines: 1,
                style: context.tt.titleLarge?.copyWith(
                    fontSize: wide ? 24 : 20, fontWeight: FontWeight.w700, fontFeatures: tabular, color: context.cs.onSurface)),
          ),
          SizedBox(height: wide ? 8 : 6),
          Text(sub, style: context.tt.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
        ]),
      ),
    );
  }
}

class _EmptyText extends StatelessWidget {
  const _EmptyText(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 8),
        child: Center(child: Text(text, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted))),
      );
}

/// "Doanh thu theo ngày": bar chart of every day of the range, then the web's table (Ngày, Đơn, Doanh thu, Lãi gộp).
class _DayCard extends StatelessWidget {
  const _DayCard({required this.report});
  final ReportData report;

  @override
  Widget build(BuildContext context) {
    final r = report;
    return SectionCard(
      title: 'Doanh thu theo ngày',
      child: r.summary.orders == 0
          ? const _EmptyText('Không có đơn hoàn tất trong khoảng này.')
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              ReportBarChart(
                key: const Key('day-chart'),
                data: [
                  for (final d in r.days)
                    BarDatum(
                      label: dayLabel(d.day),
                      value: d.revenue,
                      empty: d.orders == 0,
                      tooltip: '${dayLabel(d.day)}: ${money(d.revenue)} · ${d.orders} đơn',
                    ),
                ],
                xTitle: 'Ngày',
                minSlotWidth: 14,
                labelWidth: 38,
                startAtEnd: true,
                semanticLabel: 'Biểu đồ doanh thu theo ngày',
              ),
              const SizedBox(height: 16),
              _DayTable(days: r.days),
            ]),
    );
  }
}

class _DayTable extends StatelessWidget {
  const _DayTable({required this.days});
  final List<DaySales> days;

  @override
  Widget build(BuildContext context) {
    final co = context.co;
    final maxRevenue = days.fold<double>(1, (m, d) => math.max(m, d.revenue));
    final numStyle = context.tt.bodyMedium?.copyWith(fontSize: 14, fontFeatures: tabular, height: 1.3);
    final head = context.tt.labelSmall;
    return LayoutBuilder(builder: (context, c) {
      final showBar = c.maxWidth >= 520; // the web hides the bar column below sm
      Widget row({required Widget day, Widget? bar, required Widget orders, required Widget revenue, required Widget profit}) {
        return Row(children: [
          SizedBox(width: 54, child: day),
          if (showBar) Expanded(flex: 4, child: Padding(padding: const EdgeInsets.only(right: 12), child: bar ?? const SizedBox())),
          SizedBox(width: 44, child: Align(alignment: Alignment.centerRight, child: orders)),
          Expanded(flex: 3, child: Align(alignment: Alignment.centerRight, child: revenue)),
          Expanded(flex: 3, child: Align(alignment: Alignment.centerRight, child: profit)),
        ]);
      }

      Text cell(String s, TextStyle? style) => Text(s, maxLines: 1, softWrap: false, overflow: TextOverflow.fade, style: style);

      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
          decoration: BoxDecoration(color: context.cs.surfaceContainerLow, borderRadius: BorderRadius.circular(6)),
          child: row(
            day: Text('NGÀY', style: head),
            orders: Text('ĐƠN', style: head),
            revenue: Text('DOANH THU', style: head),
            profit: Text('LÃI GỘP', style: head),
          ),
        ),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 410),
          child: ListView.separated(
            shrinkWrap: true,
            primary: false,
            padding: EdgeInsets.zero,
            itemCount: days.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final d = days[i];
              final style = d.orders == 0 ? numStyle?.copyWith(color: co.muted) : numStyle;
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
                child: row(
                  day: cell(dayLabel(d.day), style),
                  bar: Container(
                    height: 8,
                    alignment: Alignment.centerLeft,
                    child: FractionallySizedBox(
                      widthFactor: (d.revenue / maxRevenue).clamp(0.0, 1.0),
                      child: Container(decoration: BoxDecoration(color: co.cta, borderRadius: BorderRadius.circular(2))),
                    ),
                  ),
                  orders: cell('${d.orders}', style),
                  revenue: cell(money(d.revenue), style),
                  profit: cell(money(d.profit), style),
                ),
              );
            },
          ),
        ),
      ]);
    });
  }
}

/// "Món bán chạy (theo doanh thu)": top 10 with quantity, gross profit and its margin.
class _TopProductsCard extends StatelessWidget {
  const _TopProductsCard({required this.report});
  final ReportData report;

  @override
  Widget build(BuildContext context) {
    final top = report.top;
    return SectionCard(
      title: 'Món bán chạy (theo doanh thu)',
      child: top.isEmpty
          ? const _EmptyText('Chưa có dữ liệu.')
          : Column(children: [
              for (var i = 0; i < top.length; i++) ...[
                if (i > 0) const Divider(height: 1),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Row(children: [
                    SizedBox(
                      width: 26,
                      child: Text('${i + 1}', style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
                    ),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(top[i].name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                        Text(_topSub(top[i]), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
                      ]),
                    ),
                    const SizedBox(width: 12),
                    Text(money(top[i].revenue), style: context.tt.bodyMedium?.copyWith(fontFeatures: tabular)),
                  ]),
                ),
              ],
            ]),
    );
  }

  static String _topSub(TopProduct p) {
    final margin = p.revenue > 0 ? ' (${pct(p.profit / p.revenue * 100)})' : '';
    return '${qty(p.qty)} ly/phần · lãi gộp ${money(p.profit)}$margin';
  }
}

/// "Theo giờ trong ngày": 24 bars (0–23h), grey stub for hours without orders, value on tap.
class _HourCard extends StatelessWidget {
  const _HourCard({required this.report});
  final ReportData report;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Theo giờ trong ngày',
      child: ReportBarChart(
        key: const Key('hour-chart'),
        data: [
          for (final h in report.hours)
            BarDatum(
              label: '${h.hour}',
              value: h.revenue,
              empty: h.orders == 0,
              tooltip: '${h.hour}h: ${money(h.revenue)} · ${h.orders} đơn',
            ),
        ],
        xTitle: 'Giờ',
        minSlotWidth: 22,
        labelWidth: 16,
        semanticLabel: 'Doanh thu theo giờ',
      ),
    );
  }
}

/// "Kênh bán & thanh toán": by source (POS / Zalo, share of revenue) and by payment method.
class _ChannelsCard extends StatelessWidget {
  const _ChannelsCard({required this.report});
  final ReportData report;

  @override
  Widget build(BuildContext context) {
    final r = report;
    final channels = _Breakdown(heading: 'Kênh', rows: [
      for (final s in r.bySource) (label: s.label, meta: '· ${s.orders} đơn · ${share(s.revenue, r.summary.revenue)}', value: money(s.revenue)),
    ]);
    final payments = _Breakdown(heading: 'Thanh toán', rows: [
      for (final p in r.byPayment) (label: p.label, meta: '· ${p.orders} đơn', value: money(p.revenue)),
    ]);
    return SectionCard(
      title: 'Kênh bán & thanh toán',
      child: LayoutBuilder(builder: (context, c) {
        if (c.maxWidth >= 520) {
          return IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(child: channels),
              const VerticalDivider(width: 33),
              Expanded(child: payments),
            ]),
          );
        }
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [channels, const Divider(height: 29), payments]);
      }),
    );
  }
}

class _Breakdown extends StatelessWidget {
  const _Breakdown({required this.heading, required this.rows});
  final String heading;
  final List<({String label, String meta, String value})> rows;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(heading.toUpperCase(), style: context.tt.labelSmall),
      const SizedBox(height: 8),
      if (rows.isEmpty) Text('—', style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
      for (final row in rows)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Text.rich(TextSpan(children: [
                TextSpan(text: row.label),
                TextSpan(text: ' ${row.meta}', style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
              ])),
            ),
            const SizedBox(width: 12),
            Text(row.value, style: context.tt.bodyMedium?.copyWith(fontFeatures: tabular)),
          ]),
        ),
    ]);
  }
}
