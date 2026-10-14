import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';

enum RankTone { critical, warning }

/// One row of a ranking (partials/barchart.ejs): label, value for the bar, display text, tooltip detail.
class RankRow {
  const RankRow({required this.label, required this.value, required this.display, required this.detail, this.tone, this.onTap});

  final String label;
  final num value;
  final String display;
  final String detail;
  final RankTone? tone;
  final VoidCallback? onTap;
}

/// Horizontal ranking bar chart: rank, label (tappable when it leads somewhere), optional status badge,
/// value on the right, bar = value / max (at least 2%). Tap a bar for "{label} · {detail}".
class RankChart extends StatelessWidget {
  const RankChart({
    super.key,
    required this.title,
    required this.subtitle,
    required this.rows,
    required this.empty,
    this.linkLabel,
    this.onLink,
  });

  final String title;
  final String subtitle;
  final List<RankRow> rows;
  final String empty;
  final String? linkLabel;
  final VoidCallback? onLink;

  @override
  Widget build(BuildContext context) {
    final max = rows.fold<num>(1, (m, r) => r.value > m ? r.value : m);
    return SectionCard(
      title: title,
      subtitle: subtitle,
      trailing: linkLabel == null
          ? null
          : TextButton(
              onPressed: onLink,
              style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8), minimumSize: const Size(0, 36)),
              child: Text('$linkLabel →', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            ),
      child: rows.isEmpty
          ? Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(child: Text(empty, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted))),
            )
          : Column(children: [
              for (var i = 0; i < rows.length; i++) _RankTile(rank: i + 1, row: rows[i], max: max),
            ]),
    );
  }
}

class _RankTile extends StatelessWidget {
  const _RankTile({required this.rank, required this.row, required this.max});
  final int rank;
  final RankRow row;
  final num max;

  @override
  Widget build(BuildContext context) {
    final w = row.value > 0 ? math.max(2.0, row.value / max * 100) : 0.0;
    final fill = switch (row.tone) {
      RankTone.critical => context.co.bad,
      RankTone.warning => Palette.amberPressed,
      null => context.cs.primary,
    };
    final label = Text(
      row.label,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontWeight: FontWeight.w600,
        fontSize: 14.5,
        height: 1.3,
        color: row.onTap != null ? Palette.navyAccent : context.cs.onSurface,
      ),
    );
    return InkWell(
      onTap: row.onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            SizedBox(
              width: 18,
              child: Text('$rank',
                  textAlign: TextAlign.right, style: TextStyle(fontSize: 12, fontFeatures: tabular, color: context.co.muted)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Row(children: [
                Flexible(child: label),
                if (row.tone != null) ...[
                  const SizedBox(width: 6),
                  StatusBadge(row.tone == RankTone.critical ? 'Nguy cấp' : 'Sắp hết',
                      tone: row.tone == RankTone.critical ? Tone.bad : Tone.warn, dense: true),
                ],
              ]),
            ),
            const SizedBox(width: 10),
            Text(row.display,
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, fontFeatures: tabular, color: context.cs.onSurface)),
          ]),
          const SizedBox(height: 6),
          Tooltip(
            message: '${row.label} · ${row.detail}',
            triggerMode: TooltipTriggerMode.tap,
            preferBelow: false,
            child: SizedBox(
              height: 16,
              child: LayoutBuilder(builder: (context, c) {
                return Stack(alignment: Alignment.centerLeft, children: [
                  Container(
                    height: 8,
                    decoration: BoxDecoration(
                        color: context.co.neutralTint, borderRadius: const BorderRadius.horizontal(right: Radius.circular(4))),
                  ),
                  Container(
                    width: c.maxWidth * w / 100,
                    height: 8,
                    decoration: BoxDecoration(color: fill, borderRadius: const BorderRadius.horizontal(right: Radius.circular(4))),
                  ),
                ]);
              }),
            ),
          ),
        ]),
      ),
    );
  }
}
