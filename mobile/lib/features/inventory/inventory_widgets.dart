import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'inventory_data.dart';

/// Width from which lists become tables (the shell shows the sidebar from here too).
const kWide = 840.0;

/// Web table header cell: 12 w600 uppercase muted.
class HeadCell extends StatelessWidget {
  const HeadCell(this.text, {super.key, this.right = false});
  final String text;
  final bool right;

  @override
  Widget build(BuildContext context) => Text(text.toUpperCase(),
      textAlign: right ? TextAlign.right : TextAlign.left, style: context.tt.labelSmall, maxLines: 1, overflow: TextOverflow.ellipsis);
}

/// Card wrapper for a wide table: header row on milk-50, rows separated by hairlines.
class TableCard extends StatelessWidget {
  const TableCard({super.key, required this.header, required this.rows, this.empty});
  final Widget header;
  final List<Widget> rows;
  final Widget? empty;

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(color: context.cs.surfaceContainerLow, padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12), child: header),
        const Divider(),
        if (rows.isEmpty && empty != null) empty!,
        for (var i = 0; i < rows.length; i++) ...[if (i > 0) const Divider(), rows[i]],
      ]),
    );
  }
}

/// A table row as a card on narrow screens (the web's .rtable below lg): headline, then LABEL ... value rows, then actions.
class RowCard extends StatelessWidget {
  const RowCard({super.key, required this.title, required this.fields, this.actions = const [], this.onTap, this.muted = false});
  final Widget title;
  final List<(String, Widget)> fields;
  final List<Widget> actions;
  final VoidCallback? onTap;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final body = Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        title,
        const SizedBox(height: 6),
        for (final (label, value) in fields) ...[
          const Divider(),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              Text(label.toUpperCase(), style: context.tt.labelSmall),
              const SizedBox(width: 12),
              Expanded(child: Align(alignment: Alignment.centerRight, child: value)),
            ]),
          ),
        ],
        if (actions.isNotEmpty) ...[
          const SizedBox(height: 6),
          Row(children: [
            for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(width: 8), Expanded(child: actions[i])],
          ]),
        ],
      ]),
    );
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Opacity(
        opacity: muted ? 0.7 : 1,
        child: onTap == null ? body : InkWell(onTap: onTap, child: body),
      ),
    );
  }
}

/// Lays out cards one per row on phones, two per row from 600 dp (the web's auto-fill minmax(280px, 1fr)).
class CardColumn extends StatelessWidget {
  const CardColumn({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final cols = c.maxWidth >= 600 ? 2 : 1;
      final w = (c.maxWidth - 12 * (cols - 1)) / cols;
      return Wrap(spacing: 12, runSpacing: 12, children: [for (final ch in children) SizedBox(width: w, child: ch)]);
    });
  }
}

/// Compact outlined button used for row actions (36 high, 12-13 w600).
ButtonStyle compactOutlined(BuildContext context) => OutlinedButton.styleFrom(
      minimumSize: const Size(0, 40),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.compact,
      side: BorderSide(color: context.co.line),
      foregroundColor: context.cs.primary,
      textStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w600, fontSize: 13.5),
    );

/// Link-coloured text (names that open another page).
TextStyle linkStyle(BuildContext context, {double? size}) => TextStyle(
      color: Theme.of(context).brightness == Brightness.light ? Palette.navyAccent : context.cs.primary,
      fontWeight: FontWeight.w600,
      fontSize: size,
    );

TextStyle numStyle(BuildContext context, {FontWeight weight = FontWeight.w500, Color? color}) =>
    TextStyle(fontFeatures: tabular, fontWeight: weight, color: color ?? context.cs.onSurface);

/// Ledger type: tinted icon tile + label.
class MoveTypeChip extends StatelessWidget {
  const MoveTypeChip(this.type, {super.key});
  final String type;

  @override
  Widget build(BuildContext context) {
    final m = moveMeta(type);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 28,
        height: 28,
        decoration: BoxDecoration(color: m.tone.bg(context), borderRadius: BorderRadius.circular(7)),
        child: Icon(m.icon, size: 16, color: m.tone.fg(context)),
      ),
      const SizedBox(width: 8),
      Flexible(child: Text(m.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w500))),
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- form sheet

/// Dialog on wide screens, bottom sheet on phones (the web's dialogs become sheets below sm).
Future<T?> showFormSheet<T>(BuildContext context, WidgetBuilder builder) {
  if (MediaQuery.sizeOf(context).width >= 600) {
    return showDialog<T>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 512), child: builder(ctx)),
      ),
    );
  }
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (ctx) => Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom), child: builder(ctx)),
  );
}

/// Sheet chrome: title + close, scrollable body, sticky footer "Hủy" + primary (flex 1 : 2), inline error.
class SheetFrame extends StatelessWidget {
  const SheetFrame({
    super.key,
    required this.title,
    required this.children,
    required this.primaryLabel,
    required this.onSubmit,
    this.busy = false,
    this.error,
  });
  final String title;
  final List<Widget> children;
  final String primaryLabel;
  final VoidCallback onSubmit;
  final bool busy;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 8, 8),
        child: Row(children: [
          Expanded(child: Text(title, style: context.tt.titleLarge?.copyWith(fontSize: 18))),
          IconButton(tooltip: 'Đóng', onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close_rounded)),
        ]),
      ),
      const Divider(),
      Flexible(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: 16), children[i]],
            if (error != null) ...[
              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: context.co.badTint, borderRadius: BorderRadius.circular(8)),
                child: Text(error!, style: TextStyle(color: context.co.bad)),
              ),
            ],
          ]),
        ),
      ),
      const Divider(),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(children: [
          Expanded(child: OutlinedButton(onPressed: busy ? null : () => Navigator.of(context).pop(), child: const Text('Hủy'))),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: FilledButton(
              onPressed: busy ? null : onSubmit,
              child: busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(primaryLabel),
            ),
          ),
        ]),
      ),
    ]);
  }
}

/// Label above the input, like the web forms.
class LabeledField extends StatelessWidget {
  const LabeledField({super.key, required this.label, required this.child, this.hint});
  final String label;
  final Widget child;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(label, style: context.tt.bodyMedium?.copyWith(fontWeight: FontWeight.w500, fontSize: 14)),
      const SizedBox(height: 4),
      child,
      if (hint != null) ...[const SizedBox(height: 4), Text(hint!, style: context.tt.bodySmall)],
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- stock trend chart

class _Pt {
  const _Pt(this.balance, this.at, {this.change = 0, this.type, this.start = false});
  final double balance;
  final String? at;
  final double change;
  final String? type;
  final bool start;
}

/// "Diễn biến tồn kho" (partials/stock_trend.ejs): balance after each movement as a step line, oldest to newest with
/// equal x steps, the minimum as an amber line, top/half/0 on the y axis, first and last dates underneath.
/// Tap or drag across the chart for the tooltip the web shows on hover.
class StockTrendChart extends StatefulWidget {
  const StockTrendChart({super.key, required this.movements, required this.unit, required this.minStock});
  final List<Movement> movements;
  final String unit;
  final double minStock;

  @override
  State<StockTrendChart> createState() => _StockTrendChartState();
}

class _StockTrendChartState extends State<StockTrendChart> {
  int? _sel;

  List<_Pt> get _points {
    final rows = widget.movements.reversed.toList();
    if (rows.isEmpty) return const [];
    final first = rows.first;
    return [
      _Pt(first.balanceAfter - first.change, first.createdAt, start: true),
      for (final m in rows) _Pt(m.balanceAfter, m.createdAt, change: m.change, type: m.type),
    ];
  }

  void _pick(Offset local, double width, int n) {
    if (n == 0 || width <= 0) return;
    final i = n <= 1 ? 0 : ((local.dx / width) * (n - 1)).round().clamp(0, n - 1);
    if (i != _sel) setState(() => _sel = i);
  }

  @override
  Widget build(BuildContext context) {
    final pts = _points;
    final n = pts.length;
    final min = widget.minStock;
    final unit = widget.unit;
    final rows = widget.movements.length;
    final top = [min, 1.0, ...pts.map((p) => p.balance)].reduce(math.max) * 1.15;

    final legend = (min > 0 && n > 0)
        ? Row(mainAxisSize: MainAxisSize.min, children: [
            Container(width: 16, height: 2, decoration: BoxDecoration(color: context.co.warn, borderRadius: BorderRadius.circular(1))),
            const SizedBox(width: 6),
            Text('Mức tối thiểu ', style: context.tt.bodySmall),
            Text('${qty(min)} $unit', style: context.tt.bodySmall?.copyWith(fontFeatures: tabular, color: context.cs.onSurface)),
          ])
        : null;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, spacing: 12, runSpacing: 6, children: [
            Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text('Diễn biến tồn kho', style: context.tt.titleMedium),
              Text(n > 0 ? 'Tồn sau mỗi lần xuất nhập · $rows lần gần nhất' : 'Chưa có lần xuất nhập nào', style: context.tt.bodySmall),
            ]),
            ?legend,
          ]),
          const SizedBox(height: 16),
          if (n == 0)
            Container(
              height: 160,
              alignment: Alignment.center,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(8)),
              child: Text('Biểu đồ sẽ hiện khi có nhập kho, bán hàng hoặc kiểm kê.',
                  textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
            )
          else ...[
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(
                width: 48,
                height: 160,
                child: Stack(clipBehavior: Clip.none, children: [
                  for (final (frac, v) in [(0.0, top.round()), (0.5, (top / 2).round()), (1.0, 0)])
                    Positioned(
                      right: 0,
                      top: 160 * frac - 7,
                      child: Text(qty(v), style: context.tt.bodySmall?.copyWith(fontSize: 11, fontFeatures: tabular)),
                    ),
                ]),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: LayoutBuilder(builder: (context, c) {
                  final w = c.maxWidth;
                  final sel = _sel != null && _sel! < n ? _sel : null;
                  final x = sel == null ? 0.0 : (n <= 1 ? w / 2 : sel / (n - 1) * w);
                  return GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTapDown: (d) => _pick(d.localPosition, w, n),
                    onHorizontalDragUpdate: (d) => _pick(d.localPosition, w, n),
                    child: SizedBox(
                      height: 160,
                      child: Stack(clipBehavior: Clip.none, children: [
                        Positioned.fill(
                          child: CustomPaint(
                            key: const ValueKey('stock-trend-paint'),
                            painter: _TrendPainter(
                              balances: [for (final p in pts) p.balance],
                              top: top,
                              min: min,
                              selected: sel,
                              line: context.cs.primary,
                              accent: Theme.of(context).brightness == Brightness.light ? Palette.navyAccent : context.cs.primary,
                              grid: context.co.line,
                              base: context.cs.outline,
                              minColor: context.co.warn,
                              ring: context.cs.surface,
                            ),
                          ),
                        ),
                        if (sel != null)
                          Positioned(
                            top: -8,
                            left: x <= w / 2 ? x : null,
                            right: x > w / 2 ? w - x : null,
                            child: _Tooltip(point: pts[sel], unit: unit),
                          ),
                      ]),
                    ),
                  );
                }),
              ),
            ]),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.only(left: 56),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text(shopDay(pts.first.at), style: context.tt.bodySmall?.copyWith(fontSize: 11, fontFeatures: tabular)),
                Text(shopDay(pts.last.at), style: context.tt.bodySmall?.copyWith(fontSize: 11, fontFeatures: tabular)),
              ]),
            ),
          ],
        ]),
      ),
    );
  }
}

class _Tooltip extends StatelessWidget {
  const _Tooltip({required this.point, required this.unit});
  final _Pt point;
  final String unit;

  @override
  Widget build(BuildContext context) {
    final p = point;
    final what = p.start
        ? 'Tồn trước lần đầu'
        : '${moveMeta(p.type ?? '').label} ${p.change > 0 ? '+' : '−'}${qty(p.change.abs())}';
    return IgnorePointer(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: Palette.navyDarker, borderRadius: BorderRadius.circular(6)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text('${qty(p.balance)} $unit',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 12, fontFeatures: tabular)),
          Text('$what · ${shopTime(p.at)}', style: const TextStyle(color: Palette.navySoft, fontSize: 12)),
        ]),
      ),
    );
  }
}

class _TrendPainter extends CustomPainter {
  _TrendPainter({
    required this.balances,
    required this.top,
    required this.min,
    required this.selected,
    required this.line,
    required this.accent,
    required this.grid,
    required this.base,
    required this.minColor,
    required this.ring,
  });

  final List<double> balances;
  final double top, min;
  final int? selected;
  final Color line, accent, grid, base, minColor, ring;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height, n = balances.length;
    double x(int i) => n <= 1 ? w / 2 : i / (n - 1) * w;
    double y(double v) => h - (math.max(0, v) / top) * h;

    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    canvas.drawLine(Offset(0, 0.5), Offset(w, 0.5), gridPaint);
    canvas.drawLine(Offset(0, h / 2), Offset(w, h / 2), gridPaint);
    canvas.drawLine(Offset(0, h - 0.5), Offset(w, h - 0.5), gridPaint..color = base);
    if (n == 0) return;

    final path = Path()..moveTo(x(0), y(balances[0]));
    for (var i = 1; i < n; i++) {
      path
        ..lineTo(x(i), y(balances[i - 1]))
        ..lineTo(x(i), y(balances[i]));
    }
    final area = Path.from(path)
      ..lineTo(x(n - 1), h)
      ..lineTo(x(0), h)
      ..close();
    canvas.drawPath(area, Paint()..color = line.withValues(alpha: 0.08));
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );

    if (min > 0) {
      canvas.drawLine(Offset(0, y(min)), Offset(w, y(min)), Paint()
        ..color = minColor
        ..strokeWidth = 1.2);
    }

    void dot(int i, Color c) {
      final o = Offset(x(i), y(balances[i]));
      canvas.drawCircle(o, 6.5, Paint()..color = ring);
      canvas.drawCircle(o, 4.5, Paint()..color = c);
    }

    dot(n - 1, line);
    final s = selected;
    if (s != null && s < n) {
      canvas.drawLine(Offset(x(s), 0), Offset(x(s), h), Paint()
        ..color = accent.withValues(alpha: 0.4)
        ..strokeWidth = 1);
      dot(s, accent);
    }
  }

  @override
  bool shouldRepaint(_TrendPainter old) =>
      old.balances != balances || old.top != top || old.min != min || old.selected != selected || old.line != line;
}
