import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'customer_models.dart';
import 'customer_providers.dart';
import 'customer_widgets.dart';

/// Thêm khách hàng / Sửa: {name} (views/pages/customer_form.ejs). Pushed with Navigator (no route of its own);
/// pops with the saved [Customer].
class CustomerFormScreen extends ConsumerStatefulWidget {
  const CustomerFormScreen({super.key, this.customer});

  /// null = new customer.
  final Customer? customer;

  @override
  ConsumerState<CustomerFormScreen> createState() => _CustomerFormScreenState();
}

class _CustomerFormScreenState extends ConsumerState<CustomerFormScreen> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.customer?.name ?? '');
  late final _phone = TextEditingController(text: widget.customer?.phone ?? '');
  late final _zalo = TextEditingController(text: widget.customer?.zaloUserId ?? '');
  late final _note = TextEditingController(text: widget.customer?.note ?? '');
  bool _busy = false;
  String? _error;
  String? _phoneError;
  String? _zaloError;

  bool get _isNew => widget.customer == null;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _zalo.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _phoneError = null;
      _zaloError = null;
    });
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = ref.read(apiProvider);
    final name = _name.text.trim();
    final phone = _phone.text.trim();
    final zalo = _zalo.text.trim();
    final note = _note.text.trim();
    try {
      final Map<String, dynamic> res;
      if (_isNew) {
        res = await api.post('/admin/customers', {
          'name': name,
          if (phone.isNotEmpty) 'phone': phone,
          if (zalo.isNotEmpty) 'zalo_user_id': zalo,
          if (note.isNotEmpty) 'note': note,
        });
      } else {
        // An empty phone, Zalo ID or note clears it (null), like the web update.
        res = await api.put('/admin/customers/${widget.customer!.id}', {
          'name': name,
          'phone': phone.isEmpty ? null : phone,
          'zalo_user_id': zalo.isEmpty ? null : zalo,
          'note': note.isEmpty ? null : note,
        });
      }
      final raw = res['customer'];
      final saved = raw is Map
          ? Customer.fromJson(Map<String, dynamic>.from(raw))
          : Customer(
              id: int.tryParse('${res['id']}') ?? widget.customer?.id ?? 0,
              name: name,
              phone: phone.isEmpty ? null : phone,
              zaloUserId: zalo.isEmpty ? null : zalo,
              note: note.isEmpty ? null : note,
            );
      invalidateCustomerData(ref, id: _isNew ? null : saved.id);
      if (!mounted) return;
      showToast(context, _isNew ? 'Đã thêm khách hàng "$name".' : 'Đã cập nhật thông tin khách hàng.');
      Navigator.of(context).pop(saved);
    } catch (e) {
      final ex = toApiException(e);
      var message = ex.message;
      if (ex.code == 'DUPLICATE') {
        final field = ex.details is Map ? (ex.details as Map)['field'] : null;
        if (field == 'phone') {
          message = 'Số điện thoại này đã được dùng cho khách hàng khác.';
          _phoneError = message;
        } else if (field == 'zalo_user_id') {
          message = 'Zalo ID này đã được liên kết với khách hàng khác.';
          _zaloError = message;
        } else {
          message = 'Thông tin bị trùng (số điện thoại hoặc Zalo ID đã tồn tại).';
        }
      }
      if (mounted) {
        setState(() => _error = message);
        showToast(context, message, error: true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = _isNew ? 'Thêm khách hàng' : 'Sửa: ${widget.customer!.name}';
    final mono = const TextStyle(fontFeatures: tabular, letterSpacing: 0.3);

    final phoneField = FieldLabel(
      'Số điện thoại',
      child: TextFormField(
        key: const ValueKey('form-phone'),
        controller: _phone,
        keyboardType: TextInputType.phone,
        autocorrect: false,
        style: mono,
        inputFormatters: [LengthLimitingTextInputFormatter(20)],
        decoration: InputDecoration(hintText: '09xx xxx xxx', errorText: _phoneError, errorMaxLines: 2),
      ),
    );
    final zaloField = FieldLabel(
      'Zalo ID',
      hint: 'Xem ở trang Zalo bot › sự kiện gần đây, hoặc trong đơn Zalo của khách.',
      child: TextFormField(
        key: const ValueKey('form-zalo'),
        controller: _zalo,
        autocorrect: false,
        style: mono,
        inputFormatters: [LengthLimitingTextInputFormatter(64)],
        decoration: InputDecoration(hintText: 'ID người dùng Zalo', errorText: _zaloError, errorMaxLines: 2),
      ),
    );
    final submit = FilledButton(
      onPressed: _busy ? null : _submit,
      child: _busy
          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
          : Text(_isNew ? 'Thêm khách hàng' : 'Lưu thay đổi'),
    );
    // 'Hủy' goes back where the form was opened from (list when new, the customer when editing).
    final cancel = OutlinedButton(onPressed: _busy ? null : () => Navigator.of(context).maybePop(), child: const Text('Hủy'));

    return Scaffold(
      appBar: AppBar(title: Text(title, overflow: TextOverflow.ellipsis)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 672),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(title, style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w600, color: Palette.navyDarker)),
                const SizedBox(height: 4),
                Text.rich(
                  TextSpan(style: context.tt.bodyMedium?.copyWith(color: context.co.muted), children: const [
                    TextSpan(text: 'Gắn '),
                    TextSpan(text: 'Zalo ID', style: TextStyle(fontWeight: FontWeight.w700)),
                    TextSpan(text: ' để đơn Zalo của khách tự vào sổ công nợ khi khách chốt đơn mà chưa trả tiền.'),
                  ]),
                ),
                const SizedBox(height: 18),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Form(
                      key: _form,
                      child: LayoutBuilder(builder: (context, c) {
                        final twoCols = c.maxWidth >= 560;
                        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          if (_error != null) ...[InlineError(_error!), const SizedBox(height: 14)],
                          FieldLabel(
                            'Tên khách hàng',
                            child: TextFormField(
                              key: const ValueKey('form-name'),
                              controller: _name,
                              autofocus: _isNew,
                              textCapitalization: TextCapitalization.words,
                              inputFormatters: [LengthLimitingTextInputFormatter(120)],
                              validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên khách hàng' : null,
                            ),
                          ),
                          const SizedBox(height: 16),
                          if (twoCols)
                            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Expanded(child: phoneField),
                              const SizedBox(width: 16),
                              Expanded(child: zaloField),
                            ])
                          else ...[
                            phoneField,
                            const SizedBox(height: 16),
                            zaloField,
                          ],
                          const SizedBox(height: 16),
                          FieldLabel(
                            'Ghi chú',
                            child: TextFormField(
                              key: const ValueKey('form-note'),
                              controller: _note,
                              inputFormatters: [LengthLimitingTextInputFormatter(255)],
                              decoration: const InputDecoration(hintText: 'VD: văn phòng tầng 3, ghi sổ cuối tuần'),
                            ),
                          ),
                          const SizedBox(height: 22),
                          if (twoCols)
                            Row(mainAxisAlignment: MainAxisAlignment.end, children: [cancel, const SizedBox(width: 12), submit])
                          else ...[
                            // Phone: buttons stack reversed, primary on top.
                            submit,
                            const SizedBox(height: 10),
                            cancel,
                          ],
                        ]);
                      }),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
