import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../customers/customer_models.dart';
import '../customers/customer_widgets.dart';
import 'orders_models.dart';

/// "Ghi công nợ" for a Zalo order that is not on any customer's ledger (views/pages/order_detail.ejs, debt-dialog):
/// pick a customer from the list (search by name, phone or Zalo id) or create a new one that takes the order's Zalo
/// account, and optionally link that Zalo account to the customer. POST /api/admin/orders/:id/record-debt.
/// Pops with the response ({ customer, amount, balance, linked_zalo, created_customer, notify }).
class RecordDebtSheet extends ConsumerStatefulWidget {
  const RecordDebtSheet({super.key, required this.order});
  final OrderDetail order;

  @override
  ConsumerState<RecordDebtSheet> createState() => _RecordDebtSheetState();
}

class _RecordDebtSheetState extends ConsumerState<RecordDebtSheet> {
  final _search = TextEditingController();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  Timer? _debounce;
  bool _isNew = false;
  bool _link = true;
  bool _loading = true;
  bool _busy = false;
  String? _error;
  Object? _loadError;
  List<Customer> _results = const [];
  Customer? _selected;

  @override
  void initState() {
    super.initState();
    _load('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _load(String q) async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final res = await ref.read(apiProvider).get('/admin/customers', query: {'q': q.isEmpty ? null : q});
      if (!mounted || _search.text.trim() != q) return; // a newer search is already running
      setState(() => _results = CustomerPage.fromJson(res).customers.take(8).toList());
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onSearch(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () => _load(v.trim()));
  }

  Future<void> _submit() async {
    final o = widget.order;
    final String who;
    final Map<String, dynamic> body = {};
    if (_isNew) {
      final name = _name.text.trim();
      if (name.isEmpty) {
        setState(() => _error = 'Nhập tên khách mới.');
        return;
      }
      who = name;
      body['new_customer'] = {'name': name, if (_phone.text.trim().isNotEmpty) 'phone': _phone.text.trim()};
    } else {
      final c = _selected;
      if (c == null) {
        setState(() => _error = 'Chọn một khách hàng trong danh sách, hoặc tạo khách mới.');
        return;
      }
      who = c.name;
      body['customer_id'] = c.id;
    }
    if (o.zaloUserId != null) body['link_zalo'] = _link;
    if (!await confirmAction(context, 'Ghi công nợ ${money(o.total)} (đơn ${o.orderCode}) cho $who?') || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiProvider).post('/admin/orders/${o.id}/record-debt', body);
      if (mounted) Navigator.of(context).pop(res);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.order;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Ghi công nợ · ${o.orderCode}', style: context.tt.titleLarge),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: context.co.warnTint,
            border: Border.all(color: context.co.warn.withValues(alpha: 0.4)),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            'Số tiền ghi nợ: ${money(o.total)}. Đơn vẫn "chờ thu tiền" cho tới khi bạn thu nợ.',
            style: TextStyle(color: context.co.warn, fontSize: 13.5),
          ),
        ),
        const SizedBox(height: 14),
        if (_error != null) ...[InlineError(_error!), const SizedBox(height: 12)],
        SegmentedButton<bool>(
          showSelectedIcon: false,
          segments: const [
            ButtonSegment(value: false, label: Text('Khách có sẵn')),
            ButtonSegment(value: true, label: Text('Khách mới')),
          ],
          selected: {_isNew},
          onSelectionChanged: (s) => setState(() {
            _isNew = s.first;
            _error = null;
          }),
        ),
        const SizedBox(height: 14),
        if (!_isNew) ...[
          TextField(
            key: const ValueKey('debt-search'),
            controller: _search,
            onChanged: _onSearch,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Tìm tên, số điện thoại hoặc Zalo ID'),
          ),
          const SizedBox(height: 8),
          if (_loading) const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator(minHeight: 2)),
          if (_loadError != null)
            Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(toApiException(_loadError!).message, style: TextStyle(color: context.co.bad)))
          else if (!_loading && _results.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text('Không tìm thấy khách hàng. Chuyển sang "Khách mới" để tạo.', style: context.tt.bodySmall),
            ),
          for (final c in _results)
            ListTile(
              key: ValueKey('debt-customer-${c.id}'),
              contentPadding: EdgeInsets.zero,
              dense: true,
              selected: _selected?.id == c.id,
              selectedTileColor: context.co.infoTint,
              leading: Icon(_selected?.id == c.id ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded),
              title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text([
                if (c.phone != null) c.phone!,
                if (c.balance > 0) 'nợ ${money(c.balance)}',
                if (c.zaloUserId != null) 'đã có Zalo',
              ].join(' · ')),
              onTap: () => setState(() {
                _selected = c;
                _error = null;
              }),
            ),
        ] else ...[
          FieldLabel(
            'Tên khách mới',
            child: TextField(
              key: const ValueKey('debt-new-name'),
              controller: _name,
              textCapitalization: TextCapitalization.words,
              inputFormatters: [LengthLimitingTextInputFormatter(120)],
              decoration: const InputDecoration(hintText: 'VD: Chị Lan'),
            ),
          ),
          const SizedBox(height: 12),
          FieldLabel(
            'Số điện thoại (không bắt buộc)',
            child: TextField(
              key: const ValueKey('debt-new-phone'),
              controller: _phone,
              keyboardType: TextInputType.phone,
              inputFormatters: [LengthLimitingTextInputFormatter(20)],
            ),
          ),
        ],
        if (o.zaloUserId != null) ...[
          const SizedBox(height: 8),
          SwitchListTile(
            key: const ValueKey('debt-link-zalo'),
            contentPadding: EdgeInsets.zero,
            value: _link,
            onChanged: (v) => setState(() => _link = v),
            title: const Text('Liên kết Zalo của đơn với khách này'),
            subtitle: Text('Zalo ID ${o.zaloUserId}: đơn Zalo sau tự vào sổ nợ, khách nhận thông báo.', style: context.tt.bodySmall),
          ),
        ],
        const SizedBox(height: 14),
        FilledButton(
          key: const ValueKey('debt-submit'),
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
              : const Text('Ghi công nợ'),
        ),
      ]),
    );
  }
}

/// Sentence for the toast after "Ghi công nợ", like the web flash.
String recordDebtMessage(Map<String, dynamic> res, String orderCode) {
  final c = res['customer'] is Map ? Map<String, dynamic>.from(res['customer'] as Map) : const <String, dynamic>{};
  final b = StringBuffer(
      'Đã ghi công nợ ${money(parseNum(res['amount']))} (đơn $orderCode) cho ${c['name'] ?? 'khách'}${res['created_customer'] == true ? ' (khách mới)' : ''}. Số dư nợ ${money(parseNum(res['balance']))}.');
  if (res['linked_zalo'] == true) b.write(' Đã liên kết Zalo của đơn với khách.');
  b.write(notifyText(res['notify']));
  return b.toString();
}
