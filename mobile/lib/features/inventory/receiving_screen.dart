import 'package:flutter/material.dart';
import '../../core/offline/offline_labels.dart';
import '../../core/offline/offline_writer.dart';
import '../../core/offline/offline_effects.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'inventory_data.dart';
import 'inventory_widgets.dart';

/// "Nhập kho" (views/pages/receiving.ejs): the Phiếu nhập form (item, quantity, unit cost or line total, note) and the
/// last 30 purchases. ?item={id} preselects the item.
class ReceivingScreen extends ConsumerWidget {
  const ReceivingScreen({super.key, this.itemId});
  final int? itemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(receivingItemsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Nhập kho')),
      body: RefreshIndicator(
        onRefresh: () {
          ref.invalidate(purchasesProvider);
          return ref.refresh(receivingItemsProvider.future);
        },
        child: LayoutBuilder(builder: (context, c) {
          final wide = c.maxWidth >= kWide;
          final form = AsyncBody(
            value: items,
            onRetry: () => ref.invalidate(receivingItemsProvider),
            data: (list) => _ReceiveForm(items: list, preselect: itemId),
          );
          const recent = _RecentPurchases();
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
            children: [
              Text(
                'Ghi nhận hàng mới về. Giá vốn bình quân của mặt hàng được tính lại theo số lượng và đơn giá nhập, và là cơ sở tính giá vốn (COGS) của các đơn sau.',
                style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14),
              ),
              const SizedBox(height: 16),
              if (wide)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(flex: 4, child: _FormCard(child: form)),
                  const SizedBox(width: 20),
                  const Expanded(flex: 8, child: recent),
                ])
              else ...[
                _FormCard(child: form),
                const SizedBox(height: 20),
                recent,
              ],
            ],
          );
        }),
      ),
    );
  }
}

class _FormCard extends StatelessWidget {
  const _FormCard({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Phiếu nhập', style: context.tt.titleMedium),
          const SizedBox(height: 14),
          child,
        ]),
      ),
    );
  }
}

class _ReceiveForm extends ConsumerStatefulWidget {
  const _ReceiveForm({required this.items, this.preselect});
  final List<InvItem> items;
  final int? preselect;

  @override
  ConsumerState<_ReceiveForm> createState() => _ReceiveFormState();
}

class _ReceiveFormState extends ConsumerState<_ReceiveForm> {
  final _form = GlobalKey<FormState>();
  final _qty = TextEditingController();
  final _cost = TextEditingController();
  final _note = TextEditingController();
  int? _picked;
  bool _pickedByUser = false;

  /// false: "Đơn giá nhập" per unit (the web field); true: the line total, divided by the quantity before sending.
  bool _byTotal = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    for (final c in [_qty, _cost]) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _qty.dispose();
    _cost.dispose();
    _note.dispose();
    super.dispose();
  }

  int? get _selected {
    final id = _pickedByUser ? _picked : widget.preselect;
    return widget.items.any((i) => i.id == id) ? id : null;
  }

  InvItem? get _item {
    final id = _selected;
    for (final i in widget.items) {
      if (i.id == id) return i;
    }
    return null;
  }

  double? get _unitCost {
    final q = parseAmount(_qty.text);
    final c = parseAmount(_cost.text);
    if (c == null) return null;
    if (!_byTotal) return c;
    if (q == null || q <= 0) return null;
    return double.parse((c / q).toStringAsFixed(4));
  }

  Future<void> _submit() async {
    if (_busy || !(_form.currentState?.validate() ?? false)) return;
    final item = _item!;
    final quantity = parseAmount(_qty.text)!;
    final unitCost = _unitCost!;
    final note = _note.text.trim();
    setState(() => _busy = true);
    Map<String, dynamic> res = const {};
    final ok = await runWithToast(context, () async {
      final out = await ref.read(offlineWriterProvider).submit(
        kind: 'inventory.receive',
        path: '/inventory/${item.id}/receive',
        body: {
          'quantity': quantity,
          'unit_cost': unitCost,
          if (note.isNotEmpty) 'note': note,
        },
        local: {'item': item.name, 'total': quantity * unitCost},
        effect: (db) => db.moveStock(item.id, receiveQuantity: quantity, unitCost: unitCost),
      );
      res = out.body;
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) return;
    showToast(context,
        'Đã nhập kho. Tồn mới: ${qty(res['quantity_on_hand'])}, giá vốn bình quân: ${money(res['avg_cost'])}.${res['queued'] == true ? queuedNote : ''}');
    _qty.clear();
    _cost.clear();
    _note.clear();
    invalidateInventory(ref);
  }

  @override
  Widget build(BuildContext context) {
    final item = _item;
    final sel = _selected;
    final q = parseAmount(_qty.text);
    final c = parseAmount(_cost.text);
    final unit = item?.unit ?? 'đơn vị';
    String? computed;
    if (q != null && q > 0 && c != null) {
      computed = _byTotal ? 'Đơn giá ${money(c / q)} / $unit' : 'Thành tiền ${money(q * c)}';
    }
    final decimal = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))];
    const keyboard = TextInputType.numberWithOptions(decimal: true);

    return Form(
      key: _form,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        LabeledField(
          label: 'Nguyên liệu',
          child: DropdownButtonFormField<int>(
            key: ValueKey('receive-item-$sel-${widget.items.length}'),
            initialValue: sel,
            isExpanded: true,
            hint: const Text('— chọn —'),
            items: [
              for (final i in widget.items)
                DropdownMenuItem(
                  value: i.id,
                  child: Text('${i.name} (tồn ${qty(i.quantity)} ${i.unit})', maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: (v) => setState(() {
              _picked = v;
              _pickedByUser = true;
            }),
            validator: (v) => v == null ? 'Chọn nguyên liệu.' : null,
          ),
        ),
        const SizedBox(height: 16),
        Align(
          alignment: Alignment.centerLeft,
          child: SegmentedButton<bool>(
            key: const ValueKey('receive-mode'),
            showSelectedIcon: false,
            style: SegmentedButton.styleFrom(visualDensity: VisualDensity.compact, textStyle: const TextStyle(fontFamily: kSerif, fontSize: 13.5)),
            segments: const [
              ButtonSegment(value: false, label: Text('Theo đơn giá')),
              ButtonSegment(value: true, label: Text('Theo thành tiền')),
            ],
            selected: {_byTotal},
            onSelectionChanged: (s) => setState(() => _byTotal = s.first),
          ),
        ),
        const SizedBox(height: 12),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: LabeledField(
              label: 'Số lượng',
              child: TextFormField(
                key: const ValueKey('receive-qty'),
                controller: _qty,
                keyboardType: keyboard,
                inputFormatters: decimal,
                textAlign: TextAlign.right,
                decoration: InputDecoration(suffixText: item?.unit),
                validator: (v) {
                  final n = parseAmount(v ?? '');
                  if (n == null) return 'Nhập số lượng.';
                  return n < 0.001 ? 'Số lượng phải lớn hơn 0.' : null;
                },
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: LabeledField(
              label: _byTotal ? 'Thành tiền (đ)' : 'Đơn giá nhập (đ / đơn vị)',
              child: TextFormField(
                key: const ValueKey('receive-cost'),
                controller: _cost,
                keyboardType: keyboard,
                inputFormatters: decimal,
                textAlign: TextAlign.right,
                validator: (v) {
                  final n = parseAmount(v ?? '');
                  if (n == null) return _byTotal ? 'Nhập thành tiền.' : 'Nhập đơn giá.';
                  return n < 0 ? 'Nhập một số không âm.' : null;
                },
              ),
            ),
          ),
        ]),
        if (computed != null) ...[
          const SizedBox(height: 6),
          Text(computed, key: const ValueKey('receive-computed'), textAlign: TextAlign.right, style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
        ],
        const SizedBox(height: 16),
        LabeledField(
          label: 'Ghi chú (nhà cung cấp, số hóa đơn…)',
          child: TextFormField(
            key: const ValueKey('receive-note'),
            controller: _note,
            maxLength: 255,
            buildCounter: (_, {required currentLength, required isFocused, required maxLength}) => null,
          ),
        ),
        const SizedBox(height: 18),
        FilledButton.icon(
          key: const ValueKey('receive-submit'),
          onPressed: _busy ? null : _submit,
          icon: _busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.upload_rounded, size: 20),
          label: const Text('Nhập kho'),
        ),
      ]),
    );
  }
}

/// "Lần nhập gần đây": the last 30 purchases (cards on phones, a table when wide).
class _RecentPurchases extends ConsumerWidget {
  const _RecentPurchases();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final purchases = ref.watch(purchasesProvider);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 560;
      final title = Text('Lần nhập gần đây', style: context.tt.titleMedium);
      return AsyncBody(
        value: purchases,
        onRetry: () => ref.invalidate(purchasesProvider),
        data: (rows) {
          final empty = Padding(
            padding: const EdgeInsets.symmetric(vertical: 36),
            child: Text('Chưa có lần nhập nào.', textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted, fontSize: 14)),
          );

          Widget itemCell(Purchase p, {bool right = false}) => Column(
                crossAxisAlignment: right ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  InkWell(onTap: () => context.push('/inventory/${p.itemId}'), child: Text(p.itemName, style: linkStyle(context))),
                  if (p.note?.isNotEmpty == true)
                    Text(p.note!, textAlign: right ? TextAlign.right : TextAlign.left, style: context.tt.bodySmall),
                ],
              );
          Widget qtyCell(Purchase p) => Text.rich(
                TextSpan(children: [
                  TextSpan(text: '+${qty(p.quantity)}', style: numStyle(context)),
                  TextSpan(text: ' ${p.unit}', style: TextStyle(color: context.co.muted)),
                ]),
                textAlign: TextAlign.right,
              );
          String who(Purchase p) => p.userName?.isNotEmpty == true ? p.userName! : '—';

          if (!wide) {
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              title,
              const SizedBox(height: 12),
              if (rows.isEmpty)
                Container(
                  decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(12)),
                  child: empty,
                )
              else
                CardColumn(children: [
                  for (final p in rows)
                    RowCard(
                      key: ValueKey('purchase-${p.id}'),
                      title: Text(shopTime(p.createdAt), style: const TextStyle(fontWeight: FontWeight.w600, fontFeatures: tabular)),
                      fields: [
                        ('Nguyên liệu', itemCell(p, right: true)),
                        ('Số lượng', qtyCell(p)),
                        ('Đơn giá', Text(money(p.unitCost), style: numStyle(context))),
                        ('Người nhập', Text(who(p), style: TextStyle(color: context.cs.onSurfaceVariant))),
                      ],
                    ),
                ]),
            ]);
          }

          const flex = [16, 28, 14, 13, 16];
          Widget row(List<Widget> cells) => Row(children: [
                for (var i = 0; i < cells.length; i++) ...[if (i > 0) const SizedBox(width: 12), Expanded(flex: flex[i], child: cells[i])],
              ]);
          return Card(
            clipBehavior: Clip.antiAlias,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 16), child: title),
              const Divider(),
              Container(
                color: context.cs.surfaceContainerLow,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: row(const [
                  HeadCell('Thời gian'),
                  HeadCell('Nguyên liệu'),
                  HeadCell('Số lượng', right: true),
                  HeadCell('Đơn giá', right: true),
                  HeadCell('Người nhập'),
                ]),
              ),
              const Divider(),
              if (rows.isEmpty) empty,
              for (final (i, p) in rows.indexed) ...[
                if (i > 0) const Divider(),
                Padding(
                  key: ValueKey('purchase-${p.id}'),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: row([
                    Text(shopTime(p.createdAt), style: numStyle(context)),
                    itemCell(p),
                    qtyCell(p),
                    Text(money(p.unitCost), textAlign: TextAlign.right, style: numStyle(context)),
                    Text(who(p), style: TextStyle(color: context.cs.onSurfaceVariant)),
                  ]),
                ),
              ],
            ]),
          );
        },
      );
    });
  }
}
