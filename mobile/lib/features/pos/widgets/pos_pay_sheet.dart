import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/format.dart';
import '../../../core/theme/app_theme.dart';
import '../pos_models.dart';
import 'pos_dialogs.dart';

/// Pay dialog of the web POS ('Thanh toán'): method, cash given with quick-cash buttons and change, plus the
/// UI-spec extras (discount, transfer reference). [onConfirm] runs the API calls; its error stays in the sheet.
/// Resolves to the [PayOutcome] on success, null when closed.
Future<PayOutcome?> showPaySheet(
  BuildContext context, {
  required String subtitle,
  required num subtotal,
  num discount = 0,
  bool allowDiscount = true,
  required Future<PayOutcome> Function(PayRequest req) onConfirm,
}) {
  return showPosSheet<PayOutcome>(
    context,
    maxWidth: 560,
    builder: (_) => PaySheet(subtitle: subtitle, subtotal: subtotal, discount: discount, allowDiscount: allowDiscount, onConfirm: onConfirm),
  );
}

class PaySheet extends StatefulWidget {
  const PaySheet({super.key, required this.subtitle, required this.subtotal, this.discount = 0, this.allowDiscount = true, required this.onConfirm});
  final String subtitle;

  /// Amount before the discount (the amount due when [allowDiscount] is false).
  final num subtotal;
  final num discount;
  final bool allowDiscount;
  final Future<PayOutcome> Function(PayRequest req) onConfirm;

  @override
  State<PaySheet> createState() => _PaySheetState();
}

const _methods = [
  ('cash', 'Tiền mặt', Icons.payments_outlined),
  ('transfer', 'Chuyển khoản', Icons.account_balance_outlined),
  ('card', 'Thẻ', Icons.credit_card_rounded),
];

class _PaySheetState extends State<PaySheet> {
  String _method = 'cash';
  num? _given;
  late num _discount = widget.allowDiscount ? widget.discount : 0;
  late bool _extra = widget.allowDiscount && widget.discount > 0;
  bool _busy = false;
  String? _error;
  final _givenCtrl = TextEditingController();
  late final _discountCtrl = TextEditingController(text: _discount > 0 ? '${_discount.round()}' : '');
  final _refCtrl = TextEditingController();

  num get _total => widget.subtotal - math.min(_discount, widget.subtotal);

  @override
  void dispose() {
    _givenCtrl.dispose();
    _discountCtrl.dispose();
    _refCtrl.dispose();
    super.dispose();
  }

  void _setGiven(num? v) {
    setState(() {
      _given = v;
      _error = null;
      final text = v == null ? '' : '${v.round()}';
      if (_givenCtrl.text != text) _givenCtrl.text = text;
    });
  }

  Future<void> _confirm() async {
    if (_busy) return;
    final total = _total;
    final given = _method == 'cash' ? _given : null;
    if (given != null && given > 0 && given < total) {
      setState(() => _error = 'Tiền khách đưa chưa đủ.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ref = _refCtrl.text.trim();
      final out = await widget.onConfirm(PayRequest(
        method: _method,
        tendered: given != null && given > 0 ? given : null,
        discount: math.min(_discount, widget.subtotal),
        reference: ref.isEmpty ? null : (ref.length > 100 ? ref.substring(0, 100) : ref),
      ));
      if (mounted) Navigator.of(context).pop(out);
    } catch (e) {
      if (mounted) setState(() => _error = posError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = _total;
    final quick = quickCash(total);
    final change = _given != null && _given! >= total ? _given! - total : null;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SheetTitle('Thanh toán', subtitle: widget.subtitle),
        const SizedBox(height: 8),
        FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(money(total),
              style: TextStyle(fontSize: 46, fontWeight: FontWeight.w700, color: Palette.navyDarker, fontFeatures: tabular, height: 1.15)),
        ),
        const SizedBox(height: 16),
        Row(children: [
          for (final (i, m) in _methods.indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(child: _MethodButton(label: m.$2, icon: m.$3, selected: _method == m.$1, onTap: () => setState(() {
                  _method = m.$1;
                  _error = null;
                }))),
          ],
        ]),
        if (_method == 'cash') ...[
          const SizedBox(height: 16),
          Text('Khách đưa', style: context.tt.titleSmall?.copyWith(color: context.co.neutral)),
          const SizedBox(height: 8),
          Row(children: [
            for (final (i, v) in quick.indexed) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(
                child: _QuickCash(
                  label: i == 0 ? 'Đủ tiền' : money(v),
                  selected: _given == v,
                  onTap: () => _setGiven(v),
                ),
              ),
            ],
          ]),
          const SizedBox(height: 10),
          TextField(
            controller: _givenCtrl,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            maxLength: 12,
            decoration: const InputDecoration(labelText: 'Số tiền khác (đ)', counterText: '', prefixIcon: Icon(Icons.edit_outlined)),
            onChanged: (s) => setState(() {
              _given = s.isEmpty ? null : num.tryParse(s);
              _error = null;
            }),
          ),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(color: context.cs.surfaceContainerLow, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Text('Tiền thối', style: context.tt.titleMedium?.copyWith(color: context.co.neutral)),
              const SizedBox(width: 12),
              Expanded(
                child: Align(
                  alignment: Alignment.centerRight,
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(change == null ? '—' : money(change),
                        style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: context.co.good, fontFeatures: tabular)),
                  ),
                ),
              ),
            ]),
          ),
        ],
        const SizedBox(height: 8),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => setState(() => _extra = !_extra),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(children: [
              Icon(_extra ? Icons.expand_more_rounded : Icons.chevron_right_rounded, color: Palette.navyAccent),
              const SizedBox(width: 4),
              Expanded(
                child: Text(widget.allowDiscount ? 'Giảm giá · Mã tham chiếu' : 'Mã tham chiếu',
                    style: const TextStyle(color: Palette.navyAccent, fontWeight: FontWeight.w600)),
              ),
            ]),
          ),
        ),
        if (_extra) ...[
          if (widget.allowDiscount) ...[
            TextField(
              controller: _discountCtrl,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              maxLength: 12,
              decoration: InputDecoration(
                labelText: 'Giảm giá (đ)',
                counterText: '',
                helperText: 'Tạm tính ${money(widget.subtotal)}',
              ),
              onChanged: (s) => setState(() {
                _discount = num.tryParse(s) ?? 0;
                _error = null;
              }),
            ),
            const SizedBox(height: 10),
          ],
          TextField(
            controller: _refCtrl,
            maxLength: 100,
            decoration: const InputDecoration(labelText: 'Mã tham chiếu (chuyển khoản, thẻ)', counterText: ''),
          ),
          const SizedBox(height: 4),
        ],
        if (_error != null) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: context.co.badTint,
              border: Border.all(color: context.co.bad.withValues(alpha: 0.3)),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(Icons.error_outline_rounded, color: context.co.bad, size: 20),
              const SizedBox(width: 8),
              Expanded(child: Text(_error!, style: TextStyle(color: context.co.bad))),
            ]),
          ),
        ],
        const SizedBox(height: 16),
        SizedBox(
          height: 64,
          child: FilledButton(
            onPressed: _busy ? null : _confirm,
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              textStyle: const TextStyle(fontFamily: kSerif, fontSize: 19, fontWeight: FontWeight.w700),
            ),
            child: FittedBox(fit: BoxFit.scaleDown, child: Text(_busy ? 'Đang xử lý…' : 'XÁC NHẬN THANH TOÁN')),
          ),
        ),
      ]),
    );
  }
}

class _MethodButton extends StatelessWidget {
  const _MethodButton({required this.label, required this.icon, required this.selected, required this.onTap});
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: Material(
        color: selected ? Palette.infoTint : context.cs.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: selected ? Palette.navyAccent : context.cs.outline, width: 2),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: SizedBox(
            height: 60,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(icon, size: 22, color: selected ? Palette.navy : context.co.neutral),
                const SizedBox(height: 2),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(label,
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: selected ? Palette.navy : context.co.neutral)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _QuickCash extends StatelessWidget {
  const _QuickCash({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Palette.infoTint : context.cs.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: selected ? Palette.navyAccent : context.co.line, width: selected ? 2 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: SizedBox(
          height: 50,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Center(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(label,
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15, fontFeatures: tabular, color: selected ? Palette.navy : null)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
