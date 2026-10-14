import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// Admin building blocks shared by the Thực đơn, Bàn and Cài đặt screens: the web's dialog (bottom sheet on
/// phones), the responsive table (`.rtable`: cards on phones, a real table from 840 dp) and the confirm box.

/// Width under which dialogs open as bottom sheets (web breakpoint sm).
const kSheetBreakpoint = 600.0;

/// Width from which lists are shown as a real table instead of cards.
const kTableBreakpoint = 840.0;

/// Opens [builder] like the web's `<dialog>`: a bottom sheet up to 94% of the height on phones, a centred
/// dialog (max [maxWidth]) from 600 dp. The sheet content is usually a [FormSheet].
Future<T?> showFormSheet<T>(BuildContext context, {required WidgetBuilder builder, double maxWidth = 448}) {
  final size = MediaQuery.sizeOf(context);
  if (size.width < kSheetBreakpoint) {
    return showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      constraints: BoxConstraints(maxHeight: size.height * 0.94),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: builder(ctx),
      ),
    );
  }
  return showDialog<T>(
    context: context,
    barrierColor: Palette.navyDarker.withValues(alpha: 0.55),
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(24),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth, maxHeight: MediaQuery.sizeOf(ctx).height * 0.9),
        child: builder(ctx),
      ),
    ),
  );
}

/// Dialog body like the web's: title row with a close button, scrolling fields, sticky footer
/// 'Hủy' (flex 1) + primary (flex 2). Errors from the server are shown inside the sheet ([error]),
/// because a toast would sit under the modal barrier.
class FormSheet extends StatelessWidget {
  const FormSheet({
    super.key,
    required this.title,
    required this.children,
    required this.onSubmit,
    this.formKey,
    this.submitLabel = 'Lưu',
    this.busy = false,
    this.error,
  });

  final String title;
  final List<Widget> children;
  final VoidCallback? onSubmit;
  final GlobalKey<FormState>? formKey;
  final String submitLabel;
  final bool busy;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Form(
      key: formKey,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
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
              if (error != null) ...[InlineError(error!), const SizedBox(height: 16)],
              for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: 16), children[i]],
            ]),
          ),
        ),
        const Divider(),
        Padding(
          padding: EdgeInsets.fromLTRB(16, 12, 16, 12 + bottom),
          child: Row(children: [
            Expanded(child: OutlinedButton(onPressed: busy ? null : () => Navigator.of(context).pop(), child: const Text('Hủy'))),
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: FilledButton(
                onPressed: busy ? null : onSubmit,
                child: busy
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : Text(submitLabel),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}

/// Label above the input (web `label`), optional hint under it.
class LabeledField extends StatelessWidget {
  const LabeledField({super.key, required this.label, required this.child, this.hint});
  final String label;
  final Widget child;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
      const SizedBox(height: 6),
      child,
      if (hint != null) ...[const SizedBox(height: 4), Text(hint!, style: context.tt.bodySmall)],
    ]);
  }
}

class InlineError extends StatelessWidget {
  const InlineError(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: context.co.badTint, borderRadius: BorderRadius.circular(10)),
      child: Text(message, style: TextStyle(color: context.co.bad)),
    );
  }
}

/// Small uppercase grey heading (web `h2.text-sm.uppercase.text-gray-500`).
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text.toUpperCase(), style: context.tt.labelSmall?.copyWith(fontSize: 13, letterSpacing: 0.7));
}

/// Ghost action button of the web tables (pencil 'Sửa', 'Ngừng dùng', 'Khóa', ...).
class GhostAction extends StatelessWidget {
  const GhostAction({super.key, required this.label, required this.onPressed, this.icon, this.tooltip});
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final style = TextButton.styleFrom(
      minimumSize: const Size(44, 40),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      textStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w600, fontSize: 13.5),
    );
    final button = icon == null
        ? TextButton(style: style, onPressed: onPressed, child: Text(label))
        : TextButton.icon(style: style, onPressed: onPressed, icon: Icon(icon, size: 17), label: Text(label));
    return tooltip == null ? button : Tooltip(message: tooltip!, child: button);
  }
}

/// One `.rtable` row as a phone card: headline without label, then LABEL ... value rows, then right-aligned
/// actions. Inactive rows are greyed like the web (`text-gray-400`).
class RowCard extends StatelessWidget {
  const RowCard({super.key, required this.title, this.fields = const [], this.actions = const [], this.onTap, this.dimmed = false});
  final Widget title;
  final List<(String, Widget)> fields;
  final List<Widget> actions;
  final VoidCallback? onTap;
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: title),
      for (final (label, value) in fields) ...[
        const Divider(),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 9),
          child: Row(children: [
            Text(label.toUpperCase(), style: context.tt.labelSmall),
            const SizedBox(width: 12),
            Expanded(child: Align(alignment: Alignment.centerRight, child: value)),
          ]),
        ),
      ],
    ]);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            dimmed ? Opacity(opacity: 0.55, child: body) : body,
            if (actions.isNotEmpty) ...[
              const Divider(),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Wrap(alignment: WrapAlignment.end, crossAxisAlignment: WrapCrossAlignment.center, spacing: 4, children: actions),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Lays out [cards] in one column on phones and two from 600 dp (the web's auto-fill minmax(280px, 1fr)).
class CardGrid extends StatelessWidget {
  const CardGrid({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final cols = c.maxWidth >= kSheetBreakpoint ? 2 : 1;
      final w = (c.maxWidth - 12 * (cols - 1)) / cols;
      return Wrap(spacing: 12, runSpacing: 12, children: [for (final child in children) SizedBox(width: w, child: child)]);
    });
  }
}

class WideColumn {
  const WideColumn(this.label, {this.flex = 1, this.end = false});
  final String label;
  final int flex;
  final bool end;
}

class WideRow {
  const WideRow({required this.cells, this.onTap, this.dimmed = false});
  final List<Widget> cells;
  final VoidCallback? onTap;
  final bool dimmed;
}

/// The web table from 840 dp: milk header with uppercase labels, rows split by lines, numbers right-aligned.
/// The last cell of each row is the actions cell and is never greyed.
class WideTable extends StatelessWidget {
  const WideTable({super.key, required this.columns, required this.rows, this.empty});
  final List<WideColumn> columns;
  final List<WideRow> rows;
  final Widget? empty;

  Widget _cell(WideColumn col, Widget child) => Expanded(
        flex: col.flex,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Align(alignment: col.end ? Alignment.centerRight : Alignment.centerLeft, child: child),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          color: context.cs.surfaceContainerLow,
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 12),
          child: Row(children: [
            for (final col in columns) _cell(col, Text(col.label.toUpperCase(), style: context.tt.labelSmall)),
          ]),
        ),
        if (rows.isEmpty && empty != null) ...[const Divider(), empty!],
        for (final r in rows) ...[
          const Divider(),
          InkWell(
            onTap: r.onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
              child: Row(children: [
                for (var i = 0; i < columns.length; i++)
                  _cell(
                    columns[i],
                    r.dimmed && i < columns.length - 1 ? Opacity(opacity: 0.55, child: r.cells[i]) : r.cells[i],
                  ),
              ]),
            ),
          ),
        ],
      ]),
    );
  }
}

/// The web's confirm box (data-confirm): 'Xác nhận', message, 'Quay lại' + 'Đồng ý' (danger).
Future<bool> confirmAction(BuildContext context, String message) async {
  final ok = await showDialog<bool>(
    context: context,
    barrierColor: Palette.navyDarker.withValues(alpha: 0.55),
    builder: (ctx) => AlertDialog(
      title: const Text('Xác nhận'),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Quay lại')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: ctx.co.bad, foregroundColor: Colors.white),
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Đồng ý'),
        ),
      ],
    ),
  );
  return ok ?? false;
}

/// Centres page content and caps its width on very wide screens.
class PageWidth extends StatelessWidget {
  const PageWidth({super.key, required this.child, this.maxWidth = 1200});
  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) =>
      Align(alignment: Alignment.topCenter, child: ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth), child: child));
}
