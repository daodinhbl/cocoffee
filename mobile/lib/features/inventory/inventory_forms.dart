import 'package:flutter/material.dart';
import '../../core/offline/offline_labels.dart';
import '../../core/offline/offline_writer.dart';
import '../../core/offline/offline_effects.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/widgets/common.dart';
import 'inventory_data.dart';
import 'inventory_widgets.dart';

/// "Thêm nguyên liệu" (item null) or "Sửa nguyên liệu": the web's #item-dialog (partials/inventory_dialogs.ejs).
Future<void> openItemForm(BuildContext context, {InvItem? item}) =>
    showFormSheet<void>(context, (_) => ItemFormSheet(item: item));

/// "Kiểm kê — {name}": the web's #adjust-dialog.
Future<void> openAdjust(BuildContext context, InvItem item) => showFormSheet<void>(context, (_) => AdjustSheet(item: item));

final _decimal = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))];
const _decimalKeyboard = TextInputType.numberWithOptions(decimal: true);

String? _nonNegative(String? v, {bool required = false}) {
  final s = (v ?? '').trim();
  if (s.isEmpty) return required ? 'Bắt buộc nhập.' : null;
  final n = parseAmount(s);
  if (n == null || n < 0) return 'Nhập một số không âm.';
  return null;
}

class ItemFormSheet extends ConsumerStatefulWidget {
  const ItemFormSheet({super.key, this.item});
  final InvItem? item;

  @override
  ConsumerState<ItemFormSheet> createState() => _ItemFormSheetState();
}

class _ItemFormSheetState extends ConsumerState<ItemFormSheet> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name, _sku, _unit, _min, _qty, _cost;
  late bool _active;
  bool _busy = false;
  String? _error;

  bool get _isNew => widget.item == null;

  @override
  void initState() {
    super.initState();
    final i = widget.item;
    _name = TextEditingController(text: i?.name ?? '');
    _sku = TextEditingController(text: i?.sku ?? '');
    _unit = TextEditingController(text: i?.unit ?? '');
    _min = TextEditingController(text: plainNumber(i?.minStock ?? 0));
    _qty = TextEditingController(text: '0');
    _cost = TextEditingController(text: '0');
    _active = i?.isActive ?? true;
  }

  @override
  void dispose() {
    for (final c in [_name, _sku, _unit, _min, _qty, _cost]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = ref.read(apiProvider);
    final name = _name.text.trim();
    final min = parseAmount(_min.text) ?? 0;
    try {
      String message;
      if (_isNew) {
        // POST /api/inventory { sku, name, unit, min_stock, quantity_on_hand, avg_cost }; is_active is not taken by the
        // API today, so an item created as "not in use" is switched off with a follow-up PUT.
        final res = await api.post('/inventory', {
          'sku': _sku.text.trim().toUpperCase(),
          'name': name,
          'unit': _unit.text.trim(),
          'min_stock': min,
          'quantity_on_hand': parseAmount(_qty.text) ?? 0,
          'avg_cost': parseAmount(_cost.text) ?? 0,
          'is_active': _active,
        });
        final created = res['item'];
        if (!_active && created is Map && asFlag(created['is_active'])) {
          await api.put('/inventory/${asInt(created['id'])}', {'is_active': false});
        }
        message = 'Đã thêm nguyên liệu $name.';
      } else {
        await api.put('/inventory/${widget.item!.id}', {
          'name': name,
          'unit': _unit.text.trim(),
          'min_stock': min,
          'is_active': _active,
        });
        message = 'Đã cập nhật nguyên liệu.';
      }
      invalidateInventory(ref);
      if (!mounted) return;
      showToast(context, message);
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = toApiException(e).message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _form,
      child: SheetFrame(
        title: _isNew ? 'Thêm nguyên liệu' : 'Sửa nguyên liệu',
        primaryLabel: 'Lưu',
        busy: _busy,
        error: _error,
        onSubmit: _submit,
        children: [
          LabeledField(
            label: 'Tên',
            child: TextFormField(
              key: const ValueKey('item-name'),
              controller: _name,
              maxLength: 150,
              buildCounter: _noCounter,
              textInputAction: TextInputAction.next,
              validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên nguyên liệu.' : null,
            ),
          ),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: LabeledField(
                label: 'Mã (SKU)',
                child: TextFormField(
                  key: const ValueKey('item-sku'),
                  controller: _sku,
                  readOnly: !_isNew,
                  enabled: _isNew,
                  maxLength: 40,
                  buildCounter: _noCounter,
                  textCapitalization: TextCapitalization.characters,
                  style: const TextStyle(fontFamily: 'monospace'),
                  validator: (v) => _isNew && (v ?? '').trim().isEmpty ? 'Nhập mã SKU.' : null,
                ),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: LabeledField(
                label: 'Đơn vị',
                child: TextFormField(
                  key: const ValueKey('item-unit'),
                  controller: _unit,
                  maxLength: 20,
                  buildCounter: _noCounter,
                  decoration: const InputDecoration(hintText: 'g, ml, bao…'),
                  validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập đơn vị.' : null,
                ),
              ),
            ),
          ]),
          LabeledField(
            label: 'Tồn tối thiểu (cảnh báo khi bằng hoặc thấp hơn)',
            child: TextFormField(
              key: const ValueKey('item-min'),
              controller: _min,
              keyboardType: _decimalKeyboard,
              inputFormatters: _decimal,
              textAlign: TextAlign.right,
              validator: (v) => _nonNegative(v),
            ),
          ),
          if (_isNew)
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Expanded(
                  child: LabeledField(
                    label: 'Tồn đầu kỳ',
                    child: TextFormField(
                      key: const ValueKey('item-qty'),
                      controller: _qty,
                      keyboardType: _decimalKeyboard,
                      inputFormatters: _decimal,
                      textAlign: TextAlign.right,
                      validator: (v) => _nonNegative(v),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: LabeledField(
                    label: 'Giá vốn / đơn vị (đ)',
                    child: TextFormField(
                      key: const ValueKey('item-cost'),
                      controller: _cost,
                      keyboardType: _decimalKeyboard,
                      inputFormatters: _decimal,
                      textAlign: TextAlign.right,
                      validator: (v) {
                        final base = _nonNegative(v);
                        if (base != null) return base;
                        // Same rule as the web: opening stock at cost 0 would zero the COGS of every drink using it.
                        final q = parseAmount(_qty.text) ?? 0;
                        final c = parseAmount(v ?? '') ?? 0;
                        return q > 0 && !(c > 0) ? 'Nhập giá vốn (đ/đơn vị) cho tồn đầu kỳ.' : null;
                      },
                    ),
                  ),
                ),
              ]),
              const SizedBox(height: 6),
              Text('Chỉ dùng khi thêm mới. Sau đó tồn kho thay đổi qua Nhập kho và Kiểm kê.', style: Theme.of(context).textTheme.bodySmall),
            ]),
          CheckboxListTile(
            key: const ValueKey('item-active'),
            value: _active,
            onChanged: (v) => setState(() => _active = v ?? true),
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            dense: true,
            title: const Text('Đang sử dụng'),
          ),
        ],
      ),
    );
  }
}

Widget? _noCounter(BuildContext context, {required int currentLength, required bool isFocused, required int? maxLength}) => null;

class AdjustSheet extends ConsumerStatefulWidget {
  const AdjustSheet({super.key, required this.item});
  final InvItem item;

  @override
  ConsumerState<AdjustSheet> createState() => _AdjustSheetState();
}

class _AdjustSheetState extends ConsumerState<AdjustSheet> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _qty = TextEditingController(text: plainNumber(widget.item.quantity));
  final _note = TextEditingController();
  String _type = 'adjustment';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _qty.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final note = _note.text.trim();
      final newQuantity = parseAmount(_qty.text) ?? 0;
      final out = await ref.read(offlineWriterProvider).submit(
        kind: 'inventory.adjust',
        path: '/inventory/${widget.item.id}/adjust',
        body: {
          'new_quantity': newQuantity,
          'expected_quantity': widget.item.quantity, // the stock the count was based on: the server applies the difference
          'type': _type,
          if (note.isNotEmpty) 'note': note,
        },
        local: {'item': widget.item.name},
        effect: (db) => db.moveStock(widget.item.id, newQuantity: newQuantity),
      );
      final res = out.body;
      final delta = asDouble(res['delta']);
      invalidateInventory(ref);
      if (!mounted) return;
      showToast(context, delta == 0 ? 'Số lượng không đổi.' : 'Đã điều chỉnh tồn kho (${signed(delta)}).${res['queued'] == true ? queuedNote : ''}');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = toApiException(e).message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _form,
      child: SheetFrame(
        title: 'Kiểm kê — ${widget.item.name}',
        primaryLabel: 'Ghi nhận',
        busy: _busy,
        error: _error,
        onSubmit: _submit,
        children: [
          LabeledField(
            label: 'Loại điều chỉnh',
            child: DropdownButtonFormField<String>(
              key: const ValueKey('adjust-type'),
              initialValue: _type,
              isExpanded: true,
              items: const [
                DropdownMenuItem(value: 'adjustment', child: Text('Kiểm kê (đặt lại số thực tế)')),
                DropdownMenuItem(value: 'waste', child: Text('Hao hụt / hỏng (đặt lại số còn lại)')),
              ],
              onChanged: (v) => setState(() => _type = v ?? 'adjustment'),
            ),
          ),
          LabeledField(
            label: 'Số lượng thực tế còn lại',
            hint: 'Hiện tồn ${qty(widget.item.quantity)} ${widget.item.unit}',
            child: TextFormField(
              key: const ValueKey('adjust-qty'),
              controller: _qty,
              keyboardType: _decimalKeyboard,
              inputFormatters: _decimal,
              textAlign: TextAlign.right,
              decoration: InputDecoration(suffixText: widget.item.unit),
              validator: (v) => _nonNegative(v, required: true),
            ),
          ),
          LabeledField(
            label: 'Ghi chú',
            child: TextFormField(
              key: const ValueKey('adjust-note'),
              controller: _note,
              maxLength: 255,
              buildCounter: _noCounter,
              decoration: const InputDecoration(hintText: 'VD: kiểm kê cuối tháng'),
            ),
          ),
        ],
      ),
    );
  }
}
