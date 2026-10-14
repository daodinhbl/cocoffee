import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import 'order_widgets.dart';
import 'orders_models.dart';

/// Result of POST /api/orders/:id/pay -> { order, change }.
class PayResult {
  const PayResult({required this.orderCode, required this.change});
  final String orderCode;
  final num change;
}

/// Order errors in Vietnamese (POS_MESSAGES and admin/orders.js wording on the web).
ApiException orderError(Object error) {
  final a = toApiException(error);
  final text = switch (a.code) {
    'INSUFFICIENT_PAYMENT' => 'Tiền khách đưa chưa đủ.',
    'ORDER_NOT_PAYABLE' => 'Đơn không còn ở trạng thái thanh toán được.',
    'ORDER_NOT_OPEN' => 'Đơn không còn mở.',
    'EMPTY_ORDER' => 'Đơn chưa có món nào.',
    'ORDER_NOT_CANCELLABLE' => 'Chỉ hủy được đơn đang chờ xác nhận hoặc đang phục vụ.',
    'NOT_APPLICABLE' => 'Chỉ đơn Zalo đã hoàn tất mới có bill Zalo.',
    _ => null,
  };
  if (text == null) return a;
  return ApiException(code: a.code, status: a.status, details: a.details, serverMessage: a.serverMessage, message: text);
}

/// "Thu tiền" as a bottom sheet (the web's pay card on order_detail.ejs plus the POS cash box).
Future<PayResult?> showPaySheet(BuildContext context, {required OrderDetail order, required bool isAdmin}) {
  return showModalBottomSheet<PayResult>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => PaySheet(order: order, isAdmin: isAdmin),
  );
}

class PaySheet extends ConsumerStatefulWidget {
  const PaySheet({super.key, required this.order, required this.isAdmin});
  final OrderDetail order;
  final bool isAdmin;

  @override
  ConsumerState<PaySheet> createState() => _PaySheetState();
}

class _PaySheetState extends ConsumerState<PaySheet> {
  late final TextEditingController _discount;
  final _tendered = TextEditingController();
  final _reference = TextEditingController();
  String _method = 'cash';
  bool _busy = false;
  String? _error;

  OrderDetail get o => widget.order;

  /// Cashiers get the POS methods only (cash, transfer, card); "Khác" stays with admins as on the web.
  List<String> get _methods => widget.isAdmin ? const ['cash', 'transfer', 'card', 'other'] : const ['cash', 'transfer', 'card'];

  @override
  void initState() {
    super.initState();
    _discount = TextEditingController(text: o.isOpen && o.discount > 0 ? '${o.discount.round()}' : '');
  }

  @override
  void dispose() {
    _discount.dispose();
    _tendered.dispose();
    _reference.dispose();
    super.dispose();
  }

  num get _discountValue => num.tryParse(_discount.text) ?? 0;
  num? get _tenderedValue => _tendered.text.isEmpty ? null : num.tryParse(_tendered.text);

  /// Open orders: subtotal − discount typed here; completed (Zalo) orders: the order total.
  num get _due => o.isOpen ? math.max<num>(0, o.subtotal - _discountValue) : o.total;

  String? get _discountError => o.isOpen && _discountValue > o.subtotal ? 'Giảm giá không được lớn hơn tạm tính của đơn.' : null;
  bool get _cash => _method == 'cash';
  bool get _short => _cash && _tenderedValue != null && _tenderedValue! < _due;
  bool get _valid => _discountError == null && !_short;

  /// Same quick amounts as the POS: exact, next 50k, next 100k, +100k, 500k (at most four).
  List<num> get _quick {
    final t = _due;
    final opts = <num>[t, (t / 50000).ceil() * 50000, (t / 100000).ceil() * 100000, (t / 100000).ceil() * 100000 + 100000, 500000];
    final out = <num>[];
    for (final v in opts) {
      if (v >= t && !out.contains(v)) out.add(v);
    }
    return out.take(4).toList();
  }

  Future<void> _submit() async {
    if (!_valid || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final body = <String, dynamic>{'method': _method};
    if (o.isOpen) body['discount'] = _discountValue;
    if (_cash && _tenderedValue != null) body['tendered'] = _tenderedValue;
    final reference = _reference.text.trim();
    if (reference.isNotEmpty) body['reference'] = reference;
    try {
      final res = await ref.read(apiProvider).post('/orders/${o.id}/pay', body);
      final order = res['order'];
      final code = order is Map && order['order_code'] != null ? '${order['order_code']}' : o.orderCode;
      final change = res['change'];
      if (!mounted) return;
      Navigator.of(context).pop(PayResult(orderCode: code, change: change is num ? change : num.tryParse('$change') ?? 0));
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = orderError(e).message;
        });
      }
    }
  }

  Widget _label(String text, {String? hint}) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text.rich(TextSpan(children: [
          TextSpan(text: text, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
          if (hint != null) TextSpan(text: ' $hint', style: TextStyle(color: context.co.muted, fontSize: 13)),
        ])),
      );

  @override
  Widget build(BuildContext context) {
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    final tendered = _tenderedValue;
    final submitLabel = o.isOpen ? 'Thu tiền & hoàn tất đơn' : 'Thu ${money(o.total)}';
    return Padding(
      padding: EdgeInsets.only(bottom: inset),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(child: Text('Thu tiền', style: context.tt.titleLarge)),
            Text(o.orderCode, style: TextStyle(fontFamily: kMono, fontWeight: FontWeight.w600, color: context.co.muted)),
          ]),
          const SizedBox(height: 6),
          Text(
            o.isOpen
                ? 'Thu tiền và hoàn tất đơn ${o.orderCode}? Số tiền = tạm tính − giảm giá đã nhập.'
                : 'Ghi nhận thu ${money(o.total)} cho đơn ${o.orderCode}?',
            style: context.tt.bodySmall?.copyWith(fontSize: 13.5),
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
            decoration: BoxDecoration(color: context.co.neutralTint, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Expanded(child: Text('Cần thu', style: TextStyle(fontWeight: FontWeight.w600, color: context.co.muted))),
              Text(money(_due),
                  key: const Key('pay-due'),
                  style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w700, fontFeatures: tabular)),
            ]),
          ),
          const SizedBox(height: 16),
          _label('Hình thức thanh toán'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final m in _methods)
              ChoiceChip(
                key: Key('pay-method-$m'),
                label: Text(methodLabel(m)),
                selected: _method == m,
                showCheckmark: false,
                selectedColor: context.co.infoTint,
                side: BorderSide(color: _method == m ? Palette.navyAccent : context.co.line),
                labelStyle: TextStyle(
                    fontFamily: kSerif,
                    fontWeight: FontWeight.w600,
                    color: _method == m ? context.cs.primary : context.cs.onSurface),
                onSelected: (_) => setState(() => _method = m),
              ),
          ]),
          if (o.isOpen) ...[
            const SizedBox(height: 16),
            _label('Giảm giá (đ)'),
            TextField(
              key: const Key('pay-discount'),
              controller: _discount,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
              textAlign: TextAlign.right,
              style: const TextStyle(fontFeatures: tabular),
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(hintText: '0', suffixText: 'đ', errorText: _discountError, errorMaxLines: 2),
            ),
          ],
          if (_cash) ...[
            const SizedBox(height: 16),
            _label('Khách đưa', hint: '(để trống nếu đưa đủ)'),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final (i, v) in _quick.indexed)
                ChoiceChip(
                  label: Text(i == 0 ? 'Đủ tiền' : money(v)),
                  selected: tendered == v,
                  showCheckmark: false,
                  selectedColor: context.co.infoTint,
                  side: BorderSide(color: tendered == v ? Palette.navyAccent : context.co.line),
                  labelStyle: TextStyle(
                      fontFamily: kSerif,
                      fontWeight: FontWeight.w600,
                      fontFeatures: tabular,
                      color: tendered == v ? context.cs.primary : context.cs.onSurface),
                  onSelected: (_) => setState(() => _tendered.text = '${v.round()}'),
                ),
            ]),
            const SizedBox(height: 8),
            TextField(
              key: const Key('pay-tendered'),
              controller: _tendered,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
              textAlign: TextAlign.right,
              style: const TextStyle(fontFeatures: tabular),
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(hintText: vnd(_due), suffixText: 'đ'),
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 14),
              decoration: BoxDecoration(color: context.cs.surfaceContainerLow, borderRadius: BorderRadius.circular(12)),
              child: Row(children: [
                Expanded(
                  child: Text(_short ? 'Còn thiếu' : 'Tiền thối',
                      style: TextStyle(fontWeight: FontWeight.w600, color: _short ? context.co.bad : context.co.muted)),
                ),
                Text(
                  tendered == null ? '—' : money((tendered - _due).abs()),
                  key: const Key('pay-change'),
                  style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      fontFeatures: tabular,
                      color: _short ? context.co.bad : context.co.good),
                ),
              ]),
            ),
          ],
          const SizedBox(height: 16),
          _label('Mã tham chiếu', hint: '(tùy chọn)'),
          TextField(
            key: const Key('pay-reference'),
            controller: _reference,
            autocorrect: false,
            inputFormatters: [LengthLimitingTextInputFormatter(100)],
          ),
          if (_error != null) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: context.co.badTint, borderRadius: BorderRadius.circular(10)),
              child: Text(_error!, style: TextStyle(color: context.co.bad)),
            ),
          ],
          const SizedBox(height: 18),
          FilledButton.icon(
            key: const Key('pay-submit'),
            onPressed: _valid && !_busy ? _submit : null,
            icon: _busy
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Icon(Icons.check_rounded),
            label: Text(submitLabel),
          ),
        ]),
      ),
    );
  }
}
