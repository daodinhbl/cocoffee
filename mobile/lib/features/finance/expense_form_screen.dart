import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'finance_data.dart';

/// The server refuses photos above 600 KB (imageStore); the picker already scales and recompresses.
const _maxPhotoBytes = 580 * 1024;

String _isoDay(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
String _viDay(String iso) => iso.length >= 10 ? '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}' : iso;

/// Add (expense == null) or edit one manual expense. Rows booked from a stock receipt only allow the category and
/// the note (the amount comes from the receipt), like the web form.
class ExpenseFormScreen extends ConsumerStatefulWidget {
  const ExpenseFormScreen({super.key, this.expense});
  final Expense? expense;

  @override
  ConsumerState<ExpenseFormScreen> createState() => _ExpenseFormState();
}

class _ExpenseFormState extends ConsumerState<ExpenseFormScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _amount, _payee, _docNo, _note;
  late DateTime _date;
  int? _categoryId;
  bool _vat = false, _busy = false, _removePhoto = false;
  Uint8List? _photo;

  Expense? get _e => widget.expense;
  bool get _purchase => _e?.fromPurchase ?? false;

  @override
  void initState() {
    super.initState();
    final e = _e;
    _amount = TextEditingController(text: e == null ? '' : '${e.amount.round()}');
    _payee = TextEditingController(text: e?.payee ?? '');
    _docNo = TextEditingController(text: e?.docNo ?? '');
    _note = TextEditingController(text: e?.note ?? '');
    _date = e != null ? (DateTime.tryParse(e.date) ?? DateTime.now()) : DateTime.now();
    _categoryId = e?.categoryId;
    _vat = e?.vatIncluded ?? false;
  }

  @override
  void dispose() {
    for (final c in [_amount, _payee, _docNo, _note]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickPhoto(ImageSource source) async {
    try {
      final x = await ImagePicker().pickImage(source: source, maxWidth: 1280, maxHeight: 1280, imageQuality: 60);
      if (x == null) return;
      final bytes = await x.readAsBytes();
      if (bytes.length > _maxPhotoBytes) {
        if (mounted) showToast(context, 'Ảnh còn quá nặng (${(bytes.length / 1024).round()} KB). Chụp lại gần hơn hoặc chọn ảnh nhỏ hơn.', error: true);
        return;
      }
      setState(() {
        _photo = bytes;
        _removePhoto = false;
      });
    } catch (e) {
      if (mounted) showToast(context, 'Không mở được máy ảnh/thư viện ảnh: $e', error: true);
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if (_categoryId == null) {
      showToast(context, 'Chọn nhóm chi phí.', error: true);
      return;
    }
    final amount = num.tryParse(_amount.text.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;
    final input = ExpenseInput(
      date: _isoDay(_date), categoryId: _categoryId!, amount: amount, vatIncluded: _vat,
      payee: _payee.text.trim(), docNo: _docNo.text.trim(), note: _note.text.trim(),
      imageData: _photo == null ? null : 'data:image/jpeg;base64,${base64Encode(_photo!)}', removeImage: _removePhoto,
    );
    setState(() => _busy = true);
    final actions = ref.read(financeActionsProvider);
    var queued = false;
    final ok = await runWithToast(context, () async {
      if (_e == null) {
        queued = (await actions.create(input)).queued;
      } else {
        await actions.update(_e!.id, input);
      }
    }, success: null);
    if (ok && mounted) {
      showToast(context, _e != null ? 'Đã cập nhật chi phí.' : queued ? 'Chưa có mạng: đã lưu trong hàng chờ, sẽ gửi khi có mạng lại.' : 'Đã ghi chi phí.');
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final cats = ref.watch(expenseCategoriesProvider);
    final hasStoredPhoto = (_e?.hasReceipt ?? false) && !_removePhoto && _photo == null;
    return Scaffold(
      appBar: AppBar(title: Text(_e == null ? 'Thêm chi phí' : 'Sửa chi phí')),
      body: AsyncBody(
        value: cats,
        onRetry: () => ref.invalidate(expenseCategoriesProvider),
        data: (list) => Form(
          key: _form,
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 32), children: [
            if (_purchase)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text('Khoản này tự sinh từ phiếu nhập ${_e!.purchaseCode ?? ''}. Chỉ đổi được nhóm chi phí và ghi chú; số tiền theo phiếu nhập.',
                    style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
              ),
            InkWell(
              onTap: _purchase
                  ? null
                  : () async {
                      final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime(2024), lastDate: DateTime.now().add(const Duration(days: 1)));
                      if (d != null) setState(() => _date = d);
                    },
              child: InputDecorator(
                decoration: const InputDecoration(labelText: 'Ngày chi', suffixIcon: Icon(Icons.calendar_today_rounded, size: 18)),
                child: Text(_viDay(_isoDay(_date))),
              ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: list.any((c) => c.id == _categoryId) ? _categoryId : null,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Nhóm chi phí'),
              items: [for (final c in list) DropdownMenuItem(value: c.id, child: Text(c.name, overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setState(() => _categoryId = v),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _amount,
              enabled: !_purchase,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Số tiền (đ)'),
              validator: (v) => (num.tryParse(v ?? '') ?? 0) >= 1 ? null : 'Nhập số tiền lớn hơn 0',
            ),
            if (!_purchase) ...[
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Đã gồm VAT đầu vào'),
                value: _vat,
                onChanged: (v) => setState(() => _vat = v),
              ),
              TextFormField(controller: _payee, maxLength: 120, decoration: const InputDecoration(labelText: 'Chi cho ai (không bắt buộc)')),
              TextFormField(controller: _docNo, maxLength: 40, decoration: const InputDecoration(labelText: 'Số chứng từ (không bắt buộc)')),
            ],
            TextFormField(controller: _note, maxLength: 255, maxLines: 2, decoration: const InputDecoration(labelText: 'Ghi chú')),
            if (!_purchase) ...[
              const SizedBox(height: 8),
              Text('Ảnh chứng từ', style: context.tt.titleSmall),
              const SizedBox(height: 8),
              if (_photo != null)
                ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.memory(_photo!, height: 200, fit: BoxFit.cover))
              else if (hasStoredPhoto)
                Text('Đã có ảnh chứng từ (xem ở chi tiết khoản chi).', style: context.tt.bodySmall),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                OutlinedButton.icon(onPressed: _busy ? null : () => _pickPhoto(ImageSource.camera), icon: const Icon(Icons.photo_camera_rounded), label: const Text('Chụp ảnh')),
                OutlinedButton.icon(onPressed: _busy ? null : () => _pickPhoto(ImageSource.gallery), icon: const Icon(Icons.photo_library_rounded), label: const Text('Chọn ảnh')),
                if (_photo != null || hasStoredPhoto)
                  TextButton.icon(
                    onPressed: () => setState(() {
                      if (_photo != null) {
                        _photo = null;
                      } else {
                        _removePhoto = true;
                      }
                    }),
                    icon: const Icon(Icons.delete_outline_rounded),
                    label: Text(_photo != null ? 'Bỏ ảnh mới' : 'Xóa ảnh cũ'),
                  ),
              ]),
            ],
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _busy ? null : _save,
              icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.check_rounded),
              label: Text(_e == null ? 'Ghi chi phí' : 'Lưu thay đổi'),
            ),
            const SizedBox(height: 8),
            Text('Số tiền hiện tại: ${money(num.tryParse(_amount.text) ?? 0)}', style: context.tt.bodySmall),
          ]),
        ),
      ),
    );
  }
}

/// Full-screen receipt photo, loaded with the bearer token.
class ReceiptViewer extends ConsumerWidget {
  const ReceiptViewer({super.key, required this.expenseId});
  final int expenseId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Ảnh chứng từ')),
      body: FutureBuilder<Uint8List?>(
        future: ref.read(financeActionsProvider).receiptBytes(expenseId),
        builder: (context, s) {
          if (s.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          final b = s.data;
          if (b == null) return ErrorPanel(error: ApiException(code: 'NOT_FOUND', message: 'Không tải được ảnh chứng từ.'));
          return InteractiveViewer(maxScale: 5, child: Center(child: Image.memory(b)));
        },
      ),
    );
  }
}
