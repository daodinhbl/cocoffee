import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/format.dart';
import '../../../core/theme/app_theme.dart';
import '../dashboard_models.dart';

String _hh(int h) => h.toString().padLeft(2, '0');

/// Tooltip text of one bar, as on the web: "09:00 · 125.000đ · 4 đơn".
String hourTooltip(HourSales h) => '${_hh(h.hour)}:00 · ${money(h.revenue)} · ${h.orders} đơn';

/// "Doanh thu theo giờ": 17 vertical bars (06..22) drawn with CustomPaint. The current shop hour is amber,
/// other hours navy, empty hours a grey 3% stub. Tap a bar to read its tooltip. Scrolls sideways below 560 dp.
class HourlyChart extends StatefulWidget {
  const HourlyChart({super.key, required this.hours, required this.nowHour});

  final List<HourSales> hours;
  final int nowHour;

  @override
  State<HourlyChart> createState() => _HourlyChartState();
}

class _HourlyChartState extends State<HourlyChart> {
  int? _selected;

  void _select(Offset local, double width) {
    if (widget.hours.isEmpty) return;
    final i = (local.dx / (width / widget.hours.length)).floor().clamp(0, widget.hours.length - 1);
    setState(() => _selected = _selected == i ? null : i);
  }

  @override
  Widget build(BuildContext context) {
    final sel = _selected == null || _selected! >= widget.hours.length ? null : widget.hours[_selected!];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
        height: 30,
        child: Align(
          alignment: Alignment.centerLeft,
          child: sel == null
              ? null
              : Container(
                  key: const ValueKey('hour-tooltip'),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(color: Palette.navyDarker, borderRadius: BorderRadius.circular(6)),
                  child: Text(hourTooltip(sel),
                      style: const TextStyle(color: Colors.white, fontSize: 12.5, fontFeatures: tabular, height: 1.25)),
                ),
        ),
      ),
      const SizedBox(height: 6),
      LayoutBuilder(builder: (context, c) {
        final width = math.max(560.0, c.maxWidth);
        final chart = GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => _select(d.localPosition, width),
          child: Semantics(
            label: 'Doanh thu từng giờ trong ngày',
            value: [for (final h in widget.hours) if (h.revenue > 0) hourTooltip(h)].join('; '),
            child: CustomPaint(
              key: const ValueKey('hourly-chart'),
              size: Size(width, 160),
              painter: HourlyChartPainter(
                hours: widget.hours,
                nowHour: widget.nowHour,
                selected: _selected,
                bar: context.cs.primary,
                barSelected: Palette.navyAccent,
                barNow: Palette.amber,
                empty: context.co.line,
                label: context.co.muted,
                labelNow: context.cs.primary,
              ),
            ),
          ),
        );
        if (width <= c.maxWidth) return chart;
        return SingleChildScrollView(scrollDirection: Axis.horizontal, child: chart);
      }),
    ]);
  }
}

class HourlyChartPainter extends CustomPainter {
  HourlyChartPainter({
    required this.hours,
    required this.nowHour,
    required this.selected,
    required this.bar,
    required this.barSelected,
    required this.barNow,
    required this.empty,
    required this.label,
    required this.labelNow,
  });

  final List<HourSales> hours;
  final int nowHour;
  final int? selected;
  final Color bar, barSelected, barNow, empty, label, labelNow;

  static const _gap = 6.0;
  static const _labelArea = 18.0;

  @override
  void paint(Canvas canvas, Size size) {
    if (hours.isEmpty) return;
    final maxRev = hours.fold<num>(1, (m, h) => h.revenue > m ? h.revenue : m);
    final slot = size.width / hours.length;
    final barW = math.max(2.0, slot - _gap);
    final area = size.height - _labelArea;
    final paint = Paint();

    for (var i = 0; i < hours.length; i++) {
      final h = hours[i];
      final isNow = h.hour == nowHour;
      // Same rule as the web: a bar with revenue is at least 4% tall, an empty hour is a 3% stub.
      final pctH = h.revenue > 0 ? math.max(4, (h.revenue / maxRev * 100).round()) : 3;
      final barH = area * pctH / 100;
      final left = i * slot + (slot - barW) / 2;
      paint.color = h.revenue > 0 ? (isNow ? barNow : (selected == i ? barSelected : bar)) : empty;
      canvas.drawRRect(
        RRect.fromRectAndCorners(
          Rect.fromLTWH(left, area - barH, barW, barH),
          topLeft: const Radius.circular(6),
          topRight: const Radius.circular(6),
        ),
        paint,
      );

      final tp = TextPainter(
        text: TextSpan(
          text: _hh(h.hour),
          style: TextStyle(
            fontFamily: kSerif,
            fontSize: 10,
            fontFeatures: tabular,
            fontWeight: isNow ? FontWeight.w700 : FontWeight.w400,
            color: isNow ? labelNow : label,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(i * slot + (slot - tp.width) / 2, area + 5));
    }
  }

  @override
  bool shouldRepaint(HourlyChartPainter old) =>
      old.hours != hours || old.nowHour != nowHour || old.selected != selected || old.bar != bar || old.empty != empty;
}
