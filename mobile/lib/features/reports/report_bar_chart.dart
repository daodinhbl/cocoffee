import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import 'report_models.dart';

/// One bar: x-axis label, value (đ), tooltip text shown on tap; [empty] (no orders) draws a grey stub like the web.
class BarDatum {
  const BarDatum({required this.label, required this.value, required this.tooltip, this.empty = false});
  final String label;
  final double value;
  final String tooltip;
  final bool empty;
}

/// Vertical bar chart drawn to scale: y axis from 0 to a round maximum with gridlines and short money ticks,
/// x axis with labels (thinned so they never overlap), axis titles, and the value of a bar in a tooltip on tap.
/// When the bars need more room than the card has (24 hours on a phone, long ranges) the plot scrolls
/// sideways while the y axis stays put — the web's `overflow-x-auto` with `min-w-[560px]`.
class ReportBarChart extends StatefulWidget {
  const ReportBarChart({
    super.key,
    required this.data,
    required this.xTitle,
    this.yTitle = 'Doanh thu (đ)',
    this.minSlotWidth = 12,
    this.plotHeight = 150,
    this.labelWidth = 34,
    this.startAtEnd = false,
    this.semanticLabel,
  });

  final List<BarDatum> data;
  final String xTitle;
  final String yTitle;

  /// Narrowest room per bar before the plot starts scrolling.
  final double minSlotWidth;
  final double plotHeight;

  /// Room an x label needs; labels are skipped (every 2nd, 3rd...) when slots are narrower.
  final double labelWidth;

  /// Long ranges open scrolled to the most recent bar, and labels count back from it.
  final bool startAtEnd;
  final String? semanticLabel;

  /// Key of the tappable plot area (tests tap bars through it).
  static const plotKey = ValueKey('report-chart-plot');

  static const axisWidth = 44.0;
  static const _topPad = 8.0;
  static const _labelArea = 20.0;

  @override
  State<ReportBarChart> createState() => _ReportBarChartState();
}

class _ReportBarChartState extends State<ReportBarChart> {
  int? _selected;

  @override
  void didUpdateWidget(covariant ReportBarChart old) {
    super.didUpdateWidget(old);
    if (old.data.length != widget.data.length) _selected = null;
  }

  @override
  Widget build(BuildContext context) {
    final co = context.co;
    final cs = context.cs;
    final data = widget.data;
    final n = math.max(1, data.length);
    final maxValue = data.fold<double>(0, (m, d) => math.max(m, d.value));
    final ticks = niceTicks(maxValue);
    final top = ticks.last > 0 ? ticks.last : 1.0;
    final scaler = MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.3);
    final axisStyle = (context.tt.bodySmall ?? const TextStyle())
        .copyWith(fontSize: 10.5, height: 1.1, fontFeatures: tabular, color: co.muted);
    final totalHeight = ReportBarChart._topPad + widget.plotHeight + ReportBarChart._labelArea;
    final light = Theme.of(context).brightness == Brightness.light;

    return Semantics(
      container: true,
      label: widget.semanticLabel,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Text(widget.yTitle, style: context.tt.labelSmall),
        const SizedBox(height: 4),
        LayoutBuilder(builder: (context, c) {
          final avail = math.max(0.0, c.maxWidth - ReportBarChart.axisWidth);
          final slot = math.max(avail / n, widget.minSlotWidth);
          final scrolls = slot * n > avail + 0.5;
          final width = scrolls ? slot * n : avail;
          final selected = _selected != null && _selected! < data.length ? _selected : null;

          Widget plot = SizedBox(
            key: ReportBarChart.plotKey,
            width: width,
            height: totalHeight,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (d) {
                if (data.isEmpty) return;
                final i = (d.localPosition.dx / slot).floor().clamp(0, data.length - 1);
                setState(() => _selected = _selected == i ? null : i);
              },
              child: Stack(clipBehavior: Clip.none, children: [
                Positioned.fill(
                  child: CustomPaint(
                    painter: _BarsPainter(
                      data: data,
                      ticks: ticks,
                      top: top,
                      slot: slot,
                      plotHeight: widget.plotHeight,
                      selected: selected,
                      barColor: co.cta,
                      selectedColor: light ? Palette.amberPressed : Palette.amber,
                      stubColor: light ? Palette.milk200 : co.line,
                      gridColor: co.line,
                      axisColor: co.muted,
                      highlight: cs.onSurface.withValues(alpha: 0.06),
                      labelStyle: axisStyle,
                      scaler: scaler,
                      labelWidth: widget.labelWidth,
                      labelFromEnd: widget.startAtEnd,
                    ),
                  ),
                ),
                if (selected != null)
                  Positioned.fill(
                    child: CustomSingleChildLayout(
                      delegate: _TooltipLayout(
                        anchor: Offset(
                          slot * (selected + 0.5),
                          ReportBarChart._topPad + widget.plotHeight * (1 - (data[selected].value / top).clamp(0.0, 1.0)),
                        ),
                      ),
                      child: _Tooltip(text: data[selected].tooltip),
                    ),
                  ),
              ]),
            ),
          );
          if (scrolls) {
            plot = SingleChildScrollView(scrollDirection: Axis.horizontal, reverse: widget.startAtEnd, child: plot);
          }

          return SizedBox(
            height: totalHeight,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(
                width: ReportBarChart.axisWidth,
                height: totalHeight,
                child: CustomPaint(
                  painter: _YAxisPainter(ticks: ticks, top: top, plotHeight: widget.plotHeight, style: axisStyle, scaler: scaler),
                ),
              ),
              Expanded(child: plot),
            ]),
          );
        }),
        Align(alignment: Alignment.centerRight, child: Text(widget.xTitle, style: context.tt.labelSmall)),
      ]),
    );
  }
}

class _Tooltip extends StatelessWidget {
  const _Tooltip({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: Palette.navyDarker,
        borderRadius: BorderRadius.circular(6),
        boxShadow: const [BoxShadow(color: Color(0x330F172A), blurRadius: 8, offset: Offset(0, 2))],
      ),
      child: Text(text,
          maxLines: 1,
          style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w600, fontFeatures: tabular, height: 1.3)),
    );
  }
}

/// Centres the tooltip over the bar top, kept inside the plot.
class _TooltipLayout extends SingleChildLayoutDelegate {
  _TooltipLayout({required this.anchor});
  final Offset anchor;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) => constraints.loosen();

  @override
  Offset getPositionForChild(Size size, Size child) {
    final x = (anchor.dx - child.width / 2).clamp(0.0, math.max(0.0, size.width - child.width)).toDouble();
    final y = (anchor.dy - child.height - 6).clamp(0.0, math.max(0.0, size.height - child.height)).toDouble();
    return Offset(x, y);
  }

  @override
  bool shouldRelayout(_TooltipLayout old) => old.anchor != anchor;
}

class _YAxisPainter extends CustomPainter {
  _YAxisPainter({required this.ticks, required this.top, required this.plotHeight, required this.style, required this.scaler});
  final List<double> ticks;
  final double top, plotHeight;
  final TextStyle style;
  final TextScaler scaler;

  @override
  void paint(Canvas canvas, Size size) {
    final base = ReportBarChart._topPad + plotHeight;
    for (final t in ticks) {
      final y = base - t / top * plotHeight;
      final tp = TextPainter(text: TextSpan(text: compactMoney(t), style: style), textDirection: TextDirection.ltr, textScaler: scaler)
        ..layout(maxWidth: size.width - 6);
      tp.paint(canvas, Offset(size.width - 6 - tp.width, y - tp.height / 2));
    }
  }

  @override
  bool shouldRepaint(_YAxisPainter old) =>
      old.top != top || old.plotHeight != plotHeight || old.style != style || old.scaler != scaler || old.ticks.length != ticks.length;
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({
    required this.data,
    required this.ticks,
    required this.top,
    required this.slot,
    required this.plotHeight,
    required this.selected,
    required this.barColor,
    required this.selectedColor,
    required this.stubColor,
    required this.gridColor,
    required this.axisColor,
    required this.highlight,
    required this.labelStyle,
    required this.scaler,
    required this.labelWidth,
    required this.labelFromEnd,
  });

  final List<BarDatum> data;
  final List<double> ticks;
  final double top, slot, plotHeight, labelWidth;
  final int? selected;
  final Color barColor, selectedColor, stubColor, gridColor, axisColor, highlight;
  final TextStyle labelStyle;
  final TextScaler scaler;
  final bool labelFromEnd;

  @override
  void paint(Canvas canvas, Size size) {
    final base = ReportBarChart._topPad + plotHeight;
    final grid = Paint()
      ..color = gridColor
      ..strokeWidth = 1;
    for (final t in ticks.skip(1)) {
      final y = (base - t / top * plotHeight).roundToDouble() + 0.5;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    final sel = selected;
    if (sel != null) {
      canvas.drawRect(Rect.fromLTWH(slot * sel, ReportBarChart._topPad, slot, plotHeight), Paint()..color = highlight);
    }

    final barWidth = (slot * 0.64).clamp(1.0, 28.0);
    final radius = math.min(3.0, barWidth / 2);
    final paint = Paint();
    for (var i = 0; i < data.length; i++) {
      final d = data[i];
      final cx = slot * (i + 0.5);
      final double h;
      if (d.empty || d.value <= 0) {
        h = 2;
        paint.color = stubColor;
      } else {
        h = math.max(d.value / top * plotHeight, 2);
        paint.color = i == sel ? selectedColor : barColor;
      }
      final rect = Rect.fromLTRB(cx - barWidth / 2, base - h, cx + barWidth / 2, base);
      canvas.drawRRect(RRect.fromRectAndCorners(rect, topLeft: Radius.circular(radius), topRight: Radius.circular(radius)), paint);
    }

    final axis = Paint()
      ..color = axisColor
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, base + 0.5), Offset(size.width, base + 0.5), axis);

    final every = math.max(1, (labelWidth / slot).ceil());
    for (var i = 0; i < data.length; i++) {
      final k = labelFromEnd ? data.length - 1 - i : i;
      if (k % every != 0) continue;
      final cx = slot * (i + 0.5);
      canvas.drawLine(Offset(cx, base + 1), Offset(cx, base + 4), axis);
      final tp = TextPainter(text: TextSpan(text: data[i].label, style: labelStyle), textDirection: TextDirection.ltr, textScaler: scaler)
        ..layout();
      final x = (cx - tp.width / 2).clamp(0.0, math.max(0.0, size.width - tp.width)).toDouble();
      tp.paint(canvas, Offset(x, base + 5));
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      !identical(old.data, data) ||
      old.selected != selected ||
      old.top != top ||
      old.slot != slot ||
      old.plotHeight != plotHeight ||
      old.barColor != barColor ||
      old.gridColor != gridColor ||
      old.labelStyle != labelStyle ||
      old.scaler != scaler;
}
