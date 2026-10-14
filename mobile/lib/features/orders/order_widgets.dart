import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'orders_models.dart';

/// Order codes are monospace on the web (font-mono).
const kMono = 'monospace';

/// orderStatusBadge(o) on the web.
class OrderStatusBadge extends StatelessWidget {
  const OrderStatusBadge({super.key, required this.status, this.paymentStatus, this.dense = false});
  final String status;
  final String? paymentStatus;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final (label, tone) = orderStatusLabel(status, paymentStatus);
    return StatusBadge(label, tone: tone, dense: dense);
  }
}

/// sourceBadge(source) on the web.
class SourceBadge extends StatelessWidget {
  const SourceBadge({super.key, required this.source, this.dense = false});
  final String? source;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final (label, tone) = sourceLabel(source);
    return StatusBadge(label, tone: tone, dense: dense);
  }
}

/// The dashed separator between rtable card fields.
class DashedDivider extends StatelessWidget {
  const DashedDivider({super.key, this.color});
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 1,
      width: double.infinity,
      child: CustomPaint(painter: _DashPainter(color ?? context.co.line)),
    );
  }
}

class _DashPainter extends CustomPainter {
  _DashPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (double x = 0; x < size.width; x += 7) {
      canvas.drawLine(Offset(x, 0.5), Offset((x + 4).clamp(0, size.width), 0.5), p);
    }
  }

  @override
  bool shouldRepaint(_DashPainter old) => old.color != color;
}

/// A web "section" card: small uppercase header with a bottom border, then the content.
class PanelCard extends StatelessWidget {
  const PanelCard({super.key, required this.title, required this.child, this.icon, this.amber = false, this.trailing});
  final String title;
  final Widget child;
  final IconData? icon;
  final bool amber;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final light = Theme.of(context).brightness == Brightness.light;
    final border = amber ? (light ? const Color(0xFFFDE68A) : context.co.warn.withValues(alpha: 0.5)) : context.co.line;
    final bg = amber ? (light ? const Color(0xFFFFFBEB) : context.co.warnTint) : context.cs.surface;
    final head = amber ? context.co.warn : context.co.muted;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: border))),
          child: Row(children: [
            if (icon != null) ...[Icon(icon, size: 17, color: head), const SizedBox(width: 6)],
            Expanded(
              child: Text(title.toUpperCase(),
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, letterSpacing: 0.6, color: head)),
            ),
            ?trailing,
          ]),
        ),
        child,
      ]),
    );
  }
}

/// "In hóa đơn": the printable receipt is a Web Admin page (/admin/pos/receipt/:id), opened in the browser.
Future<void> openReceipt(BuildContext context, WidgetRef ref, int orderId) async {
  final server = ref.read(serverUrlProvider);
  var ok = false;
  try {
    ok = await launchUrl(Uri.parse('$server/admin/pos/receipt/$orderId'), mode: LaunchMode.externalApplication);
  } catch (_) {
    ok = false;
  }
  if (!ok && context.mounted) showToast(context, 'Không mở được trình duyệt.', error: true);
}

/// 'YYYY-MM-DD' -> 'dd/MM/yyyy'
String dayLabel(String? iso) {
  if (iso == null || iso.length < 10) return '';
  return '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}';
}
