import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'customer_detail_screen.dart';

/// Width from which the customer pages use the web's desktop layout (tables, two columns).
const kWide = 840.0;

bool isWide(BuildContext context) => MediaQuery.sizeOf(context).width >= kWide;

/// /customers/:id through go_router; without a router (widget tests) the screen is pushed directly.
Future<void> openCustomerDetail(BuildContext context, int id) async {
  final router = GoRouter.maybeOf(context);
  if (router != null) {
    await router.push('/customers/$id');
  } else {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CustomerDetailScreen(id: id)));
  }
}

/// /orders/:id (the order detail belongs to the orders feature).
void openOrder(BuildContext context, int? id) {
  if (id == null) return;
  GoRouter.maybeOf(context)?.push('/orders/$id');
}

/// The printable statement (biên bản đối chiếu) is a Web Admin page: open it in the browser, like the web's new tab.
Future<void> openStatement(BuildContext context, WidgetRef ref, int id, {String? from, String? to}) async {
  final server = ref.read(serverUrlProvider);
  final qs = from != null && to != null && from.isNotEmpty && to.isNotEmpty ? '?from=$from&to=$to' : '';
  await _launch(context, Uri.parse('$server/admin/customers/$id/statement$qs'));
}

Future<void> callPhone(BuildContext context, String phone) =>
    _launch(context, Uri(scheme: 'tel', path: phone.replaceAll(RegExp(r'[^0-9+]'), '')));

Future<void> _launch(BuildContext context, Uri uri) async {
  var ok = false;
  try {
    ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    ok = false;
  }
  if (!ok && context.mounted) showToast(context, 'Không mở được trình duyệt.', error: true);
}

class ZaloBadge extends StatelessWidget {
  const ZaloBadge({super.key});

  @override
  Widget build(BuildContext context) => const StatusBadge('Zalo', tone: Tone.info, dense: true);
}

/// Blue link text like the web's `text-blue-700 hover:underline` anchors.
class LinkText extends StatelessWidget {
  const LinkText(this.text, {super.key, this.onTap, this.bold = false, this.size, this.maxLines = 1});
  final String text;
  final VoidCallback? onTap;
  final bool bold;
  final double? size;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final t = Text(text,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
            color: Palette.navyAccent,
            fontWeight: bold ? FontWeight.w600 : FontWeight.w500,
            fontSize: size,
            fontFeatures: tabular));
    if (onTap == null) return t;
    return InkWell(onTap: onTap, borderRadius: BorderRadius.circular(4), child: Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: t));
  }
}

/// Label + value line of an `rtable` card on phones.
class KeyValueRow extends StatelessWidget {
  const KeyValueRow({super.key, required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        Text(label, style: context.tt.bodySmall?.copyWith(fontSize: 13)),
        const SizedBox(width: 12),
        Expanded(child: Align(alignment: Alignment.centerRight, child: child)),
      ]),
    );
  }
}

/// Form label above the input, as on the web (`label` class: text-sm font-medium).
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key, required this.child, this.hint});
  final String text;
  final Widget child;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      Text(text, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
      const SizedBox(height: 6),
      child,
      if (hint != null) ...[
        const SizedBox(height: 4),
        Text(hint!, style: context.tt.bodySmall),
      ],
    ]);
  }
}

/// Web flash message after a write (green), with a close button.
class FlashBanner extends StatelessWidget {
  const FlashBanner({super.key, required this.message, this.extra, this.onClose, this.error = false});
  final String message;
  final Widget? extra;
  final VoidCallback? onClose;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final fg = error ? context.co.bad : context.co.good;
    return Container(
      decoration: BoxDecoration(
        color: error ? context.co.badTint : context.co.goodTint,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: fg.withValues(alpha: 0.25)),
      ),
      padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(error ? Icons.error_outline_rounded : Icons.check_circle_outline_rounded, color: fg, size: 20),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(message, style: TextStyle(color: fg, fontWeight: FontWeight.w600)),
            if (extra != null) ...[const SizedBox(height: 6), extra!],
          ]),
        ),
        if (onClose != null)
          IconButton(
            tooltip: 'Đóng',
            visualDensity: VisualDensity.compact,
            onPressed: onClose,
            icon: Icon(Icons.close_rounded, size: 18, color: fg),
          ),
      ]),
    );
  }
}

/// Web pagination: '← Trước', first/last/current ± 1 with '…' gaps, 'Sau →'.
class PaginationBar extends StatelessWidget {
  const PaginationBar({super.key, required this.page, required this.pages, required this.onPage});
  final int page;
  final int pages;
  final ValueChanged<int> onPage;

  @override
  Widget build(BuildContext context) {
    if (pages <= 1) return const SizedBox.shrink();
    final nums = {1, page - 1, page, page + 1, pages}.where((n) => n >= 1 && n <= pages).toList()..sort();
    final items = <Widget>[];
    if (page > 1) items.add(_PageButton(label: '← Trước', onTap: () => onPage(page - 1)));
    for (var i = 0; i < nums.length; i++) {
      if (i > 0 && nums[i] - nums[i - 1] > 1) {
        items.add(Padding(padding: const EdgeInsets.symmetric(horizontal: 2), child: Text('…', style: TextStyle(color: context.co.muted))));
      }
      final n = nums[i];
      items.add(_PageButton(label: '$n', selected: n == page, onTap: n == page ? null : () => onPage(n)));
    }
    if (page < pages) items.add(_PageButton(label: 'Sau →', onTap: () => onPage(page + 1)));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, spacing: 6, runSpacing: 6, children: items),
    );
  }
}

class _PageButton extends StatelessWidget {
  const _PageButton({required this.label, this.selected = false, this.onTap});
  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Palette.navy : context.cs.surface,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8), side: BorderSide(color: selected ? Palette.navy : context.co.line)),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.center,
          child: Text(label,
              style: TextStyle(
                  fontFeatures: tabular,
                  fontSize: 14,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                  color: selected ? Colors.white : context.cs.onSurface)),
        ),
      ),
    );
  }
}

/// Small select (the web's `<select>`), not tied to a Form so it follows the state it is given.
class SelectBox<T> extends StatelessWidget {
  const SelectBox({super.key, required this.value, required this.items, required this.onChanged, this.semanticLabel});
  final T value;
  final Map<T, String> items;
  final ValueChanged<T> onChanged;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: semanticLabel,
      child: InputDecorator(
        decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 4)),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            value: value,
            isExpanded: true,
            isDense: false,
            borderRadius: BorderRadius.circular(10),
            items: [
              for (final e in items.entries)
                DropdownMenuItem<T>(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) {
              if (v != null) onChanged(v);
            },
          ),
        ),
      ),
    );
  }
}

/// Web dialogs: bottom sheet on phones, centred dialog from 600 dp.
Future<T?> showFormSheet<T>(BuildContext context, {required WidgetBuilder builder}) {
  if (MediaQuery.sizeOf(context).width >= 600) {
    return showDialog<T>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(22, 20, 22, 20), child: builder(ctx)),
        ),
      ),
    );
  }
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (ctx) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
      child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 20), child: builder(ctx)),
    ),
  );
}

/// The web's generic confirmation (`data-confirm`): title 'Xác nhận', 'Quay lại' / 'Đồng ý'.
Future<bool> confirmAction(BuildContext context, String message) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Xác nhận'),
      content: Text(message),
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Quay lại')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Đồng ý')),
      ],
    ),
  );
  return ok ?? false;
}

/// Inline error inside sheets and forms (a toast would be hidden under a modal sheet).
class InlineError extends StatelessWidget {
  const InlineError(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: context.co.badTint, borderRadius: BorderRadius.circular(10)),
      child: Text(message, style: TextStyle(color: context.co.bad)),
    );
  }
}

/// Card with a header row (title + muted count) and divided rows, like the ledger/orders cards on the web.
class ListSectionCard extends StatelessWidget {
  const ListSectionCard({super.key, required this.title, this.count, required this.children, required this.emptyText});
  final String title;
  final String? count;
  final List<Widget> children;
  final String emptyText;

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Row(children: [
            Expanded(child: Text(title, style: context.tt.titleMedium)),
            if (count != null) Text(count!, style: context.tt.bodySmall),
          ]),
        ),
        const Divider(),
        if (children.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 36, horizontal: 16),
            child: Text(emptyText, textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
          )
        else
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const Divider(),
            children[i],
          ],
      ]),
    );
  }
}
