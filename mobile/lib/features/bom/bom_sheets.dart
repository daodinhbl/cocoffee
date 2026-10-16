import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/format.dart' as fmt;
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import '../menu/menu_models.dart';
import 'bom_models.dart';

/// Phones show a recipe line as a two-row card; from this editor width it is one row (web: sm breakpoint).
const _kWideLine = 460.0;

/// Accepts only a quantity with up to 4 decimals (',' or '.'), so typing a 5th decimal is simply ignored.
class _QtyFormatter extends TextInputFormatter {
  static final _ok = RegExp(r'^\d{0,8}([.,]\d{0,4})?$');

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) =>
      _ok.hasMatch(newValue.text) ? newValue : oldValue;
}

/// One editable recipe line: the ingredient picked (null until chosen) and the typed quantity.
class _Line {
  _Line({this.ref, String qty = ''}) : qty = TextEditingController(text: qty);

  final GlobalKey rowKey = GlobalKey();
  int? ref;
  final TextEditingController qty;
}

/// "Công thức mới" (row == null) or "Sửa công thức" (bom_recipes.ejs #recipe-dialog): name, SKU (new only), price,
/// group and the ingredient lines with live cost and margin. Pops the saved name; the caller shows the toast and
/// reloads the lists. Server errors are shown inside the sheet.
class BomRecipeForm extends ConsumerStatefulWidget {
  const BomRecipeForm({super.key, this.row, required this.categories, required this.catalog});

  final BomRow? row;
  final List<MenuCategory> categories;
  final List<CatalogItem> catalog;

  @override
  ConsumerState<BomRecipeForm> createState() => _BomRecipeFormState();
}

class _BomRecipeFormState extends ConsumerState<BomRecipeForm> {
  final _form = GlobalKey<FormState>();
  final _topKey = GlobalKey();
  final _linesKey = GlobalKey();
  late final _name = TextEditingController(text: widget.row?.name ?? '');
  late final _sku = TextEditingController(text: widget.row?.sku ?? '');
  late final _price = TextEditingController(text: widget.row == null ? '' : '${widget.row!.price.round()}');
  late final Map<int, CatalogItem> _byId = {for (final c in widget.catalog) c.id: c};

  /// Active groups, plus the drink's own group when it has been hidden since (so editing never loses it).
  late final List<MenuCategory> _categories = () {
    final list = [for (final c in widget.categories) if (c.isActive) c];
    final r = widget.row;
    if (r != null && !list.any((c) => c.id == r.categoryId)) {
      list.add(MenuCategory(id: r.categoryId, code: '', name: r.categoryName, sortOrder: 0, isActive: false));
    }
    return list;
  }();
  late int? _categoryId = widget.row?.categoryId ?? (_categories.isEmpty ? null : _categories.first.id);

  late final List<_Line> _lines = () {
    final r = widget.row;
    if (r == null || r.ingredients.isEmpty) return [_Line()];
    return [for (final g in r.ingredients) _Line(ref: g.ref, qty: plainQty(g.qty))];
  }();

  /// Removed lines: their controllers are disposed with the sheet, not while their field is still leaving the tree.
  final List<_Line> _retired = [];

  bool _busy = false;
  String? _error;
  String? _linesError;

  bool get _editing => widget.row != null;

  @override
  void dispose() {
    _name.dispose();
    _sku.dispose();
    _price.dispose();
    for (final l in [..._lines, ..._retired]) {
      l.qty.dispose();
    }
    super.dispose();
  }

  // ---------------------------------------------------------------------------------------------- live numbers

  double _lineCost(_Line l) {
    final item = l.ref == null ? null : _byId[l.ref];
    return (item?.unitCost ?? 0) * (parseQty(l.qty.text) ?? 0);
  }

  double get _cogs => _lines.fold<double>(0, (s, l) => s + _lineCost(l));

  int? get _priceValue => int.tryParse(_price.text.trim());

  static bool _qtyValid(String raw) {
    final q = parseQty(raw);
    return q != null && q > 0 && q <= kMaxRecipeQty;
  }

  // ---------------------------------------------------------------------------------------------- line actions

  void _addLine() {
    final l = _Line();
    setState(() {
      _lines.add(l);
      _linesError = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = l.rowKey.currentContext;
      if (mounted && ctx != null) {
        Scrollable.ensureVisible(ctx,
            duration: const Duration(milliseconds: 200), alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd);
      }
    });
  }

  void _removeLine(_Line l) {
    setState(() {
      _lines.remove(l);
      _retired.add(l);
      _linesError = null;
    });
  }

  Future<void> _pick(_Line l, FormFieldState<int> field) async {
    final id = await pickIngredient(
      context,
      options: [for (final c in widget.catalog) if (c.active || c.id == l.ref) c],
      selected: l.ref,
    );
    if (id == null || !mounted) return;
    field.didChange(id);
    setState(() => l.ref = id);
  }

  // ---------------------------------------------------------------------------------------------- submit

  /// Brings the first problem into view: the sheet scrolls, and the error may be far from the Save button.
  void _reveal({bool top = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      BuildContext? target;
      if (top) {
        target = _topKey.currentContext;
      } else {
        final topInvalid = _name.text.trim().isEmpty ||
            (!_editing && _sku.text.trim().isEmpty) ||
            _priceValue == null ||
            _categoryId == null;
        if (topInvalid) {
          target = _topKey.currentContext;
        } else {
          for (final l in _lines) {
            if (l.ref == null || !_qtyValid(l.qty.text)) {
              target = l.rowKey.currentContext;
              break;
            }
          }
          target ??= _linesKey.currentContext;
        }
      }
      if (target != null) Scrollable.ensureVisible(target, alignment: 0.05, duration: const Duration(milliseconds: 200));
    });
  }

  Future<void> _submit() async {
    final formOk = _form.currentState?.validate() ?? false;
    final linesError = _lines.isEmpty ? 'Công thức cần ít nhất một nguyên liệu.' : null;
    setState(() => _linesError = linesError);
    if (!formOk || linesError != null) {
      _reveal();
      return;
    }
    final name = _name.text.trim();
    final recipe = [
      for (final l in mergeLines([for (final l in _lines) RecipeLine(l.ref!, parseQty(l.qty.text)!)])) l.toJson(),
    ];
    final api = ref.read(apiProvider);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_editing) {
        await api.put('/products/${widget.row!.id}', {
          'category_id': _categoryId,
          'name': name,
          'price': int.parse(_price.text.trim()),
          'stock_mode': 'bom',
          'recipe': recipe,
          'is_active': true,
        });
      } else {
        await api.post('/products', {
          'category_id': _categoryId,
          'sku': _sku.text.trim(),
          'name': name,
          'price': int.parse(_price.text.trim()),
          'stock_mode': 'bom',
          'recipe': recipe,
          'aliases': <String>[],
        });
      }
      if (mounted) Navigator.of(context).pop(name);
    } catch (e) {
      if (mounted) {
        setState(() => _error = toApiException(e).message);
        _reveal(top: true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---------------------------------------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    return FormSheet(
      formKey: _form,
      title: _editing ? 'Sửa công thức' : 'Công thức mới',
      submitLabel: 'Lưu công thức',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        LabeledField(
          key: _topKey,
          label: 'Tên món',
          child: TextFormField(
            controller: _name,
            maxLength: 150,
            buildCounter: _noCounter,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(hintText: 'VD: Cà phê sữa đá'),
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
                onChanged: (_) => setState(() {}),
                validator: (v) => int.tryParse((v ?? '').trim()) == null ? 'Nhập giá bán' : null,
              ),
            ),
          ),
        ]),
        LabeledField(
          label: 'Nhóm món',
          child: DropdownButtonFormField<int>(
            initialValue: _categories.any((c) => c.id == _categoryId) ? _categoryId : null,
            isExpanded: true,
            items: [
              for (final c in _categories)
                DropdownMenuItem(value: c.id, child: Text('${c.name}${c.isActive ? '' : ' (ẩn)'}', overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _categoryId = v),
            validator: (v) => v == null ? 'Chọn nhóm món' : null,
          ),
        ),
        _linesEditor(context),
        _totals(context),
      ],
    );
  }

  Widget _linesEditor(BuildContext context) {
    final full = _lines.length >= kMaxRecipeLines;
    return Column(key: _linesKey, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(child: Text('Nguyên liệu (${_lines.length})', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
        OutlinedButton.icon(
          onPressed: _busy || full ? null : _addLine,
          icon: const Icon(Icons.add_rounded, size: 18),
          label: const Text('Thêm dòng'),
        ),
      ]),
      const SizedBox(height: 10),
      if (_lines.isEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text('Chưa có nguyên liệu nào. Nhấn “Thêm dòng” để thêm.', style: context.tt.bodySmall),
        ),
      for (final l in _lines) Padding(padding: const EdgeInsets.only(bottom: 10), child: _lineRow(context, l)),
      if (full) Text('Tối đa $kMaxRecipeLines dòng cho một công thức.', style: context.tt.bodySmall),
      if (_linesError != null) Text(_linesError!, style: TextStyle(color: context.co.bad, fontSize: 13.5)),
    ]);
  }

  Widget _lineRow(BuildContext context, _Line l) {
    final remove = IconButton(
      tooltip: 'Xóa dòng',
      onPressed: _busy ? null : () => _removeLine(l),
      icon: const Icon(Icons.close_rounded),
    );
    final unit = Text(l.ref == null ? '' : (_byId[l.ref]?.unit ?? ''), style: TextStyle(color: context.co.muted));
    final cost = Text(
      fmt.money(_lineCost(l)),
      textAlign: TextAlign.right,
      style: const TextStyle(fontWeight: FontWeight.w600, fontFeatures: tabular),
    );
    return Container(
      key: l.rowKey,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(10)),
      child: LayoutBuilder(builder: (context, c) {
        if (c.maxWidth >= _kWideLine) {
          return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(flex: 6, child: _picker(context, l)),
            const SizedBox(width: 8),
            Expanded(flex: 3, child: _qtyField(l)),
            const SizedBox(width: 8),
            SizedBox(width: 36, child: Padding(padding: const EdgeInsets.only(top: 15), child: unit)),
            SizedBox(width: 90, child: Padding(padding: const EdgeInsets.only(top: 15), child: cost)),
            remove,
          ]);
        }
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: _picker(context, l)), remove]),
          const SizedBox(height: 8),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(flex: 5, child: _qtyField(l)),
            const SizedBox(width: 10),
            SizedBox(width: 40, child: Padding(padding: const EdgeInsets.only(top: 15), child: unit)),
            Expanded(flex: 4, child: Padding(padding: const EdgeInsets.only(top: 15), child: cost)),
          ]),
        ]);
      }),
    );
  }

  /// Ingredient chooser: a field that opens the searchable list (a dropdown is unusable with 100 ingredients).
  Widget _picker(BuildContext context, _Line l) {
    return FormField<int>(
      initialValue: l.ref,
      autovalidateMode: AutovalidateMode.onUserInteraction,
      validator: (v) => v == null ? 'Chọn nguyên liệu' : null,
      builder: (state) {
        final item = l.ref == null ? null : _byId[l.ref];
        final text = l.ref == null ? 'Chọn nguyên liệu' : (item?.label ?? 'Nguyên liệu #${l.ref}');
        return Semantics(
          button: true,
          label: 'Thành phần',
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: _busy ? null : () => _pick(l, state),
            child: InputDecorator(
              isEmpty: l.ref == null,
              decoration: InputDecoration(errorText: state.errorText, suffixIcon: const Icon(Icons.arrow_drop_down_rounded)),
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.tt.bodyLarge?.copyWith(color: l.ref == null ? context.co.muted : null),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _qtyField(_Line l) {
    return TextFormField(
      controller: l.qty,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      inputFormatters: [_QtyFormatter()],
      textAlign: TextAlign.right,
      style: const TextStyle(fontFeatures: tabular),
      decoration: const InputDecoration(hintText: 'Định lượng'),
      onChanged: (_) => setState(() {}),
      validator: (v) {
        final q = parseQty(v ?? '');
        if (q == null || q <= 0) return 'Nhập số lớn hơn 0';
        if (q > kMaxRecipeQty) return 'Tối đa 10.000.000';
        return null;
      },
    );
  }

  /// Live "Giá vốn / Lãi gộp / Biên lợi nhuận" like the web dialog.
  Widget _totals(BuildContext context) {
    final cogs = _cogs;
    final price = _priceValue ?? 0;
    final margin = price > 0 ? (price - cogs) / price * 100 : null;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: context.cs.surfaceContainerLow,
        border: Border.all(color: context.co.line),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: _Total(label: 'Giá vốn (COGS)', value: fmt.money(cogs))),
        Expanded(child: _Total(label: 'Lãi gộp', value: price > 0 ? fmt.money(price - cogs) : '—')),
        Expanded(
          child: _Total(
            label: 'Biên lợi nhuận',
            value: margin == null ? '—' : fmt.pct(margin),
            color: margin == null ? null : marginTone(margin).fg(context),
          ),
        ),
      ]),
    );
  }
}

class _Total extends StatelessWidget {
  const _Total({required this.label, required this.value, this.color});
  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: context.tt.bodySmall),
      const SizedBox(height: 4),
      Text(value, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5, fontFeatures: tabular, color: color)),
    ]);
  }
}

// ------------------------------------------------------------------------------------------------ ingredient picker

/// Searchable list of raw materials (accents and case ignored). Returns the chosen inventory item id.
Future<int?> pickIngredient(BuildContext context, {required List<CatalogItem> options, int? selected}) {
  return showDialog<int>(
    context: context,
    barrierColor: Palette.navyDarker.withValues(alpha: 0.55),
    builder: (_) => _IngredientPicker(options: options, selected: selected),
  );
}

class _IngredientPicker extends StatefulWidget {
  const _IngredientPicker({required this.options, this.selected});
  final List<CatalogItem> options;
  final int? selected;

  @override
  State<_IngredientPicker> createState() => _IngredientPickerState();
}

class _IngredientPickerState extends State<_IngredientPicker> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = foldVi(_query.trim());
    final shown = [for (final c in widget.options) if (q.isEmpty || foldVi('${c.name} ${c.unit}').contains(q)) c];
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 440, maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(children: [
              Expanded(child: Text('Chọn nguyên liệu', style: context.tt.titleLarge?.copyWith(fontSize: 18))),
              IconButton(tooltip: 'Đóng', onPressed: () => Navigator.of(context).pop(), icon: const Icon(Icons.close_rounded)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _search,
              autofocus: true,
              onChanged: (v) => setState(() => _query = v),
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded, size: 20), hintText: 'Tìm nguyên liệu…'),
            ),
          ),
          const Divider(),
          Flexible(
            child: shown.isEmpty
                ? const EmptyState(text: 'Không có nguyên liệu phù hợp.', icon: Icons.search_off_rounded)
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: shown.length,
                    itemBuilder: (_, i) {
                      final c = shown[i];
                      final on = c.id == widget.selected;
                      return ListTile(
                        selected: on,
                        title: Text(c.label),
                        subtitle: Text('${fmt.qty(c.unitCost)}đ / ${c.unit}'),
                        trailing: on ? const Icon(Icons.check_rounded) : null,
                        onTap: () => Navigator.of(context).pop(c.id),
                      );
                    },
                  ),
          ),
        ]),
      ),
    );
  }
}

Widget? _noCounter(BuildContext context, {required int currentLength, required bool isFocused, required int? maxLength}) => null;
