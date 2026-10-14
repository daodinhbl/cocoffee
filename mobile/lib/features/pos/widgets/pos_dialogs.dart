import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/theme/app_theme.dart';
import '../pos_models.dart';

/// Phones get bottom sheets, wider screens a centred dialog (the web's dialog element), max [maxWidth] wide.
Future<T?> showPosSheet<T>(BuildContext context, {required WidgetBuilder builder, double maxWidth = 480}) {
  final phone = MediaQuery.sizeOf(context).width < 600;
  if (phone) {
    return showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: builder(ctx),
      ),
    );
  }
  return showDialog<T>(
    context: context,
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth), child: builder(ctx)),
    ),
  );
}

/// Title row with a close button, shared by the POS sheets.
class SheetTitle extends StatelessWidget {
  const SheetTitle(this.title, {super.key, this.subtitle});
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: context.tt.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: Palette.navyDarker, height: 1.25)),
          if (subtitle != null) ...[
            const SizedBox(height: 2),
            Text(subtitle!, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
          ],
        ]),
      ),
      IconButton(tooltip: 'Đóng', onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.close_rounded)),
    ]);
  }
}

/// Footer buttons 'Hủy' + primary, like the web prompt dialog.
class SheetButtons extends StatelessWidget {
  const SheetButtons({super.key, required this.primary, required this.onPrimary, this.cancel = 'Hủy', this.danger = false});
  final String primary;
  final VoidCallback? onPrimary;
  final String cancel;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Expanded(child: OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: Text(cancel))),
      const SizedBox(width: 10),
      Expanded(
        flex: 2,
        child: FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: danger ? context.co.bad : Palette.navy,
            foregroundColor: Colors.white,
          ),
          onPressed: onPrimary,
          child: Text(primary),
        ),
      ),
    ]);
  }
}

/// Confirmation (title, text, 'Quay lại' + action). Returns true when confirmed.
Future<bool> confirmPos(BuildContext context, {required String title, required String message, required String action, bool danger = false}) async {
  final ok = await showPosSheet<bool>(
    context,
    maxWidth: 440,
    builder: (ctx) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SheetTitle(title),
        const SizedBox(height: 8),
        Text(message, style: ctx.tt.bodyMedium),
        const SizedBox(height: 20),
        Row(children: [
          Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Quay lại'))),
          const SizedBox(width: 10),
          Expanded(
            flex: 2,
            child: FilledButton(
              style: FilledButton.styleFrom(backgroundColor: danger ? ctx.co.bad : Palette.navy, foregroundColor: Colors.white),
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(action),
            ),
          ),
        ]),
      ]),
    ),
  );
  return ok ?? false;
}

/// Text / number prompt of the web POS ('Ghi chú cho đơn', 'Giảm giá (đ)'). Returns null when cancelled.
Future<String?> promptPos(BuildContext context, {required String title, String initial = '', bool number = false, String? hint}) {
  return showPosSheet<String>(context, maxWidth: 440, builder: (ctx) => _Prompt(title: title, initial: initial, number: number, hint: hint));
}

class _Prompt extends StatefulWidget {
  const _Prompt({required this.title, required this.initial, required this.number, this.hint});
  final String title;
  final String initial;
  final bool number;
  final String? hint;

  @override
  State<_Prompt> createState() => _PromptState();
}

class _PromptState extends State<_Prompt> {
  late final _ctrl = TextEditingController(text: widget.initial)..selection = TextSelection(baseOffset: 0, extentOffset: widget.initial.length);

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _save() => Navigator.of(context).pop(_ctrl.text.trim());

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SheetTitle(widget.title),
        const SizedBox(height: 12),
        TextField(
          controller: _ctrl,
          autofocus: true,
          keyboardType: widget.number ? TextInputType.number : TextInputType.text,
          inputFormatters: widget.number ? [FilteringTextInputFormatter.digitsOnly] : null,
          maxLength: widget.number ? 12 : kMaxNote,
          style: const TextStyle(fontSize: 18),
          decoration: InputDecoration(hintText: widget.hint, counterText: widget.number ? '' : null),
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 12),
        SheetButtons(primary: 'Lưu', onPrimary: _save),
      ]),
    );
  }
}

/// Quick notes for a cart line (UI spec 3.1 chips [ít đá][ít đường]).
const kLineNoteChips = ['ít đá', 'không đá', 'ít đường', 'không đường', 'đá riêng', 'nóng'];

/// Per-line note: chips that toggle a phrase plus free text (<= 255). Returns null when cancelled.
Future<String?> editLineNote(BuildContext context, {required String productName, required String initial}) {
  return showPosSheet<String>(context, maxWidth: 480, builder: (ctx) => _LineNote(productName: productName, initial: initial));
}

class _LineNote extends StatefulWidget {
  const _LineNote({required this.productName, required this.initial});
  final String productName;
  final String initial;

  @override
  State<_LineNote> createState() => _LineNoteState();
}

class _LineNoteState extends State<_LineNote> {
  late final _ctrl = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  List<String> get _parts => _ctrl.text.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();

  void _toggle(String chip) {
    final parts = _parts;
    if (parts.contains(chip)) {
      parts.remove(chip);
    } else {
      parts.add(chip);
    }
    setState(() => _ctrl.text = parts.join(', '));
  }

  @override
  Widget build(BuildContext context) {
    final parts = _parts;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SheetTitle('Ghi chú món', subtitle: widget.productName),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final c in kLineNoteChips)
            FilterChip(
              label: Text(c),
              selected: parts.contains(c),
              showCheckmark: false,
              selectedColor: Palette.infoTint,
              onSelected: (_) => _toggle(c),
            ),
        ]),
        const SizedBox(height: 12),
        TextField(
          controller: _ctrl,
          maxLength: kMaxNote,
          minLines: 1,
          maxLines: 3,
          decoration: const InputDecoration(hintText: 'Ví dụ: ít đá, thêm sữa'),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        SheetButtons(primary: 'Lưu', onPrimary: () => Navigator.of(context).pop(_ctrl.text.trim())),
      ]),
    );
  }
}
