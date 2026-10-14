import 'package:flutter/material.dart' hide Thumb;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'form_sheet.dart';
import 'menu_models.dart';

/// "Thêm hàng bán lẻ" (product == null) or "Sửa {name}" (product-dialog in menu.ejs).
/// Pops the saved name; the caller shows the toast and reloads the menu.
class ProductForm extends ConsumerStatefulWidget {
  const ProductForm({super.key, this.product, required this.categories, required this.items});
  final MenuProduct? product;
  final List<MenuCategory> categories;
  final List<StockOption> items;

  @override
  ConsumerState<ProductForm> createState() => _ProductFormState();
}

class _ProductFormState extends ConsumerState<ProductForm> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.product?.name ?? '');
  late final _sku = TextEditingController(text: widget.product?.sku ?? '');
  late final _price = TextEditingController(text: widget.product == null ? '' : '${widget.product!.price.round()}');
  late final _aliases = TextEditingController(text: widget.product?.extraAliases.join('\n') ?? '');
  late int? _categoryId = widget.product?.categoryId ?? (widget.categories.isEmpty ? null : widget.categories.first.id);
  late int? _itemId = widget.product?.inventoryItemId;
  late bool _active = widget.product?.isActive ?? true;

  /// Aliases are known (from /admin/menu, or loaded below); false while loading or when the load failed.
  late bool _aliasesKnown = widget.product == null || widget.product!.aliases != null;
  bool _busy = false;
  String? _error;

  bool get _editing => widget.product != null;

  @override
  void initState() {
    super.initState();
    if (!_aliasesKnown) _loadAliases();
  }

  /// GET /api/products/:id -> { product: { aliases } } when the list came without keywords.
  Future<void> _loadAliases() async {
    try {
      final res = await ref.read(apiProvider).get('/products/${widget.product!.id}');
      final p = res['product'];
      final list = p is Map && p['aliases'] is List ? [for (final a in p['aliases'] as List) '$a'] : <String>[];
      if (!mounted) return;
      setState(() {
        _aliases.text = list.where((a) => a != widget.product!.name).join('\n');
        _aliasesKnown = true;
      });
    } catch (_) {
      // Keep the field disabled: saving then leaves the keywords unchanged.
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _sku.dispose();
    _price.dispose();
    _aliases.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final aliases = parseAliases(_aliases.text)!;
    final name = _name.text.trim();
    final price = int.parse(_price.text.trim());
    final api = ref.read(apiProvider);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_editing) {
        final p = widget.product!;
        await api.put('/products/${p.id}', {
          'name': name,
          'price': price,
          'category_id': _categoryId,
          if (!p.isBom && _itemId != null) 'inventory_item_id': _itemId,
          'is_active': _active,
          if (_aliasesKnown) 'aliases': aliases,
        });
      } else {
        await api.post('/products', {
          'category_id': _categoryId,
          'sku': _sku.text.trim(),
          'name': name,
          'price': price,
          'stock_mode': 'direct',
          'inventory_item_id': _itemId,
          'aliases': aliases,
        });
      }
      if (mounted) Navigator.of(context).pop(name);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.product;
    final itemIds = widget.items.map((i) => i.id).toSet();
    return FormSheet(
      formKey: _form,
      title: _editing ? 'Sửa ${p!.name}' : 'Thêm hàng bán lẻ',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        if (p != null)
          Row(children: [
            Thumb(url: p.imageUrl, name: p.name, size: 56),
            const SizedBox(width: 12),
            Expanded(child: Text('Ảnh món đổi trên Web Admin.', style: context.tt.bodySmall)),
          ]),
        LabeledField(
          label: 'Tên món',
          child: TextFormField(
            controller: _name,
            maxLength: 150,
            buildCounter: _noCounter,
            textInputAction: TextInputAction.next,
            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên món' : null,
          ),
        ),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: LabeledField(
              label: 'Mã (SKU)',
              hint: 'Chỉ nhập khi thêm mới.',
              child: TextFormField(
                controller: _sku,
                readOnly: _editing,
                enabled: !_editing,
                maxLength: 40,
                buildCounter: _noCounter,
                textCapitalization: TextCapitalization.characters,
                style: const TextStyle(fontFamily: 'monospace'),
                validator: (v) => !_editing && (v ?? '').trim().isEmpty ? 'Nhập mã SKU' : null,
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: LabeledField(
              label: 'Giá bán (đ)',
              child: TextFormField(
                controller: _price,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                textAlign: TextAlign.right,
                style: const TextStyle(fontFeatures: tabular),
                validator: (v) => int.tryParse((v ?? '').trim()) == null ? 'Nhập giá bán' : null,
              ),
            ),
          ),
        ]),
        LabeledField(
          label: 'Nhóm món',
          child: DropdownButtonFormField<int>(
            initialValue: widget.categories.any((c) => c.id == _categoryId) ? _categoryId : null,
            isExpanded: true,
            items: [
              for (final c in widget.categories)
                DropdownMenuItem(value: c.id, child: Text('${c.name}${c.isActive ? '' : ' (ẩn)'}', overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _categoryId = v),
            validator: (v) => v == null ? 'Chọn nhóm món' : null,
          ),
        ),
        if (p == null || !p.isBom)
          LabeledField(
            label: 'Hàng trong kho (chỉ hàng bán lẻ)',
            hint: 'Hàng bán lẻ trừ kho 1:1 theo mặt hàng này. Đồ uống pha chế bỏ qua ô này.',
            child: DropdownButtonFormField<int?>(
              initialValue: itemIds.contains(_itemId) ? _itemId : null,
              isExpanded: true,
              items: [
                const DropdownMenuItem<int?>(value: null, child: Text('— không áp dụng —')),
                for (final i in widget.items)
                  DropdownMenuItem<int?>(value: i.id, child: Text('${i.name} (${i.unit})', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) => setState(() => _itemId = v),
              validator: (v) => v == null && (p == null || p.inventoryItemId == null) ? 'Chọn hàng trong kho cho hàng bán lẻ' : null,
            ),
          ),
        LabeledField(
          label: 'Từ khóa đặt món qua Zalo',
          hint: 'Tên món luôn là một từ khóa. Mỗi từ khóa chỉ thuộc về một món.',
          child: TextFormField(
            controller: _aliases,
            enabled: _aliasesKnown,
            minLines: 3,
            maxLines: 5,
            maxLength: 1500,
            buildCounter: _noCounter,
            decoration: const InputDecoration(hintText: 'Mỗi từ khóa một dòng, VD: cf sữa\nca phe sua'),
            validator: (v) => parseAliases(v ?? '') == null ? 'Tối đa 30 từ khóa, mỗi từ khóa tối đa 100 ký tự.' : null,
          ),
        ),
        if (_editing)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _active,
            onChanged: (v) => setState(() => _active = v),
            title: const Text('Đang bán (hiện trên POS và chatbot)'),
          ),
      ],
    );
  }
}

/// "Thêm nhóm món" (category == null) or "Sửa nhóm món" (category-dialog in menu.ejs).
class CategoryForm extends ConsumerStatefulWidget {
  const CategoryForm({super.key, this.category});
  final MenuCategory? category;

  @override
  ConsumerState<CategoryForm> createState() => _CategoryFormState();
}

class _CategoryFormState extends ConsumerState<CategoryForm> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.category?.name ?? '');
  late final _code = TextEditingController(text: widget.category?.code ?? '');
  late final _sort = TextEditingController(text: '${widget.category?.sortOrder ?? 0}');
  late bool _active = widget.category?.isActive ?? true;
  bool _busy = false;
  String? _error;

  bool get _editing => widget.category != null;

  @override
  void dispose() {
    _name.dispose();
    _code.dispose();
    _sort.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final api = ref.read(apiProvider);
    final name = _name.text.trim();
    final sort = int.parse(_sort.text.trim());
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_editing) {
        await api.put('/categories/${widget.category!.id}', {'name': name, 'sort_order': sort, 'is_active': _active});
      } else {
        final res = await api.post('/categories', {'code': _code.text.trim().toLowerCase(), 'name': name, 'sort_order': sort});
        // The API ignores is_active on create: hide the new group right after when the box was unticked.
        final id = res['id'];
        if (!_active && id is num) await api.put('/categories/${id.toInt()}', {'is_active': false});
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FormSheet(
      formKey: _form,
      title: _editing ? 'Sửa nhóm món' : 'Thêm nhóm món',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        LabeledField(
          label: 'Tên nhóm',
          child: TextFormField(
            controller: _name,
            maxLength: 100,
            buildCounter: _noCounter,
            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên nhóm' : null,
          ),
        ),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: LabeledField(
              label: 'Mã nhóm',
              hint: 'Chỉ nhập khi thêm mới.',
              child: TextFormField(
                controller: _code,
                readOnly: _editing,
                enabled: !_editing,
                maxLength: 30,
                buildCounter: _noCounter,
                autocorrect: false,
                style: const TextStyle(fontFamily: 'monospace'),
                decoration: const InputDecoration(hintText: 'mixed_drink'),
                validator: (v) {
                  if (_editing) return null;
                  final code = (v ?? '').trim().toLowerCase();
                  if (code.isEmpty) return 'Nhập mã nhóm';
                  return RegExp(r'^[a-z0-9_]+$').hasMatch(code) ? null : 'Mã nhóm chỉ gồm chữ thường, số và dấu gạch dưới.';
                },
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: LabeledField(
              label: 'Thứ tự',
              child: TextFormField(
                controller: _sort,
                keyboardType: const TextInputType.numberWithOptions(signed: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'^-?\d*'))],
                textAlign: TextAlign.right,
                style: const TextStyle(fontFeatures: tabular),
                validator: (v) {
                  final n = int.tryParse((v ?? '').trim());
                  return n == null || n < -1000 || n > 1000 ? 'Từ -1000 đến 1000' : null;
                },
              ),
            ),
          ),
        ]),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _active,
          onChanged: (v) => setState(() => _active = v),
          title: const Text('Hiển thị nhóm này'),
        ),
      ],
    );
  }
}

Widget? _noCounter(BuildContext context, {required int currentLength, required bool isFocused, required int? maxLength}) => null;
