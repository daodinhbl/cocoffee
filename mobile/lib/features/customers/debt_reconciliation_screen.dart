import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'customer_models.dart';
import 'customer_providers.dart';
import 'customer_widgets.dart';

const _amber300 = Color(0xFFFCD34D);

/// Đối chiếu công nợ (views/pages/debt_reconciliation.ejs): period form with quick presets, four totals, one row per
/// customer (opening, increase, decrease, closing) with a totals footer on wide screens. There is no route for it:
/// the customers list pushes it with Navigator.
class DebtReconciliationScreen extends ConsumerStatefulWidget {
  const DebtReconciliationScreen({super.key});

  @override
  ConsumerState<DebtReconciliationScreen> createState() => _DebtReconciliationScreenState();
}

class _DebtReconciliationScreenState extends ConsumerState<DebtReconciliationScreen> {
  final _q = TextEditingController();

  /// Dates picked but not submitted yet ('Xem'); null = the period the server answered with.
  String? _from;
  String? _to;

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  void _view(Reconciliation? data) {
    ref.read(reconQueryProvider.notifier).set(from: _from ?? data?.from, to: _to ?? data?.to, q: _q.text);
  }

  void _preset(PeriodPreset p) {
    setState(() {
      _from = p.from;
      _to = p.to;
    });
    // Presets keep the search text, like the web chips.
    ref.read(reconQueryProvider.notifier).set(from: p.from, to: p.to, q: ref.read(reconQueryProvider).q);
  }

  Future<void> _pick({required bool from, required String? current}) async {
    final now = DateTime.now();
    final initial = DateTime.tryParse(current ?? '') ?? now;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2020),
      lastDate: DateTime(now.year + 1, 12, 31),
      helpText: from ? 'Từ ngày' : 'Đến ngày',
    );
    if (picked == null) return;
    setState(() => from ? _from = isoDay(picked) : _to = isoDay(picked));
  }

  Future<void> _refresh() async {
    try {
      ref.invalidate(reconciliationProvider);
      await ref.read(reconciliationProvider.future);
    } catch (_) {
      // shown below
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(reconciliationProvider);
    final data = async.value;
    final wide = isWide(context);
    final from = _from ?? data?.from;
    final to = _to ?? data?.to;

    return Scaffold(
      appBar: AppBar(title: const Text('Đối chiếu công nợ')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: Text.rich(
                TextSpan(style: context.tt.bodyMedium?.copyWith(color: context.co.muted), children: [
                  const TextSpan(text: 'Kỳ '),
                  TextSpan(
                    text: data == null ? '…' : '${fmtDay(data.from)} – ${fmtDay(data.to)}',
                    style: TextStyle(fontWeight: FontWeight.w700, color: context.cs.onSurface, fontFeatures: tabular),
                  ),
                  const TextSpan(
                      text: ': nợ đầu kỳ, phát sinh tăng, đã thu / giảm và nợ cuối kỳ của từng khách. '
                          'Bấm "Biên bản" để in gửi khách ký xác nhận.'),
                ]),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: _PeriodCard(
                controller: _q,
                from: from,
                to: to,
                presets: data?.presets ?? const [],
                activeFrom: data?.from,
                activeTo: data?.to,
                onPickFrom: () => _pick(from: true, current: from),
                onPickTo: () => _pick(from: false, current: to),
                onView: () => _view(data),
                onPreset: _preset,
              ),
            ),
            const SizedBox(height: 14),
            if (data != null) _Totals(totals: data.totals),
            if (async.isLoading && data != null)
              const Padding(padding: EdgeInsets.fromLTRB(16, 10, 16, 0), child: LinearProgressIndicator(minHeight: 2)),
            if (async.hasError && !async.isLoading)
              ErrorPanel(error: async.error!, onRetry: () => ref.invalidate(reconciliationProvider))
            else if (data == null)
              const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()))
            else ...[
              const SizedBox(height: 14),
              if (data.rows.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 20),
                      child: Text('Không có khách nào phát sinh công nợ trong kỳ này.',
                          textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
                    ),
                  ),
                )
              else if (wide)
                Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: _ReconTable(data: data))
              else
                for (final r in data.rows)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                    child: _ReconCard(row: r, from: data.from, to: data.to),
                  ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                child: Text(
                  'Nợ cuối kỳ = Nợ đầu kỳ + Phát sinh tăng − Đã thu / giảm. Số liệu lấy từ sổ công nợ '
                  '(đơn Zalo chưa thu, các lần thu nợ và điều chỉnh).',
                  style: context.tt.bodySmall,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PeriodCard extends StatelessWidget {
  const _PeriodCard({
    required this.controller,
    required this.from,
    required this.to,
    required this.presets,
    required this.activeFrom,
    required this.activeTo,
    required this.onPickFrom,
    required this.onPickTo,
    required this.onView,
    required this.onPreset,
  });
  final TextEditingController controller;
  final String? from;
  final String? to;
  final List<PeriodPreset> presets;
  final String? activeFrom;
  final String? activeTo;
  final VoidCallback onPickFrom;
  final VoidCallback onPickTo;
  final VoidCallback onView;
  final ValueChanged<PeriodPreset> onPreset;

  @override
  Widget build(BuildContext context) {
    final search = TextField(
      controller: controller,
      textInputAction: TextInputAction.search,
      onSubmitted: (_) => onView(),
      inputFormatters: [LengthLimitingTextInputFormatter(60)],
      decoration: const InputDecoration(hintText: 'Tên hoặc số điện thoại', prefixIcon: Icon(Icons.search_rounded, size: 20)),
    );
    final fromField = _DateField(label: 'Từ ngày', value: from, onTap: onPickFrom);
    final toField = _DateField(label: 'Đến ngày', value: to, onTap: onPickTo);
    final view = FilledButton(onPressed: onView, child: const Text('Xem'));

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          LayoutBuilder(builder: (context, c) {
            if (c.maxWidth >= 720) {
              return Row(children: [
                Expanded(flex: 4, child: search),
                const SizedBox(width: 12),
                Expanded(flex: 3, child: fromField),
                const SizedBox(width: 12),
                Expanded(flex: 3, child: toField),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: view),
              ]);
            }
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              search,
              const SizedBox(height: 10),
              Row(children: [Expanded(child: fromField), const SizedBox(width: 10), Expanded(child: toField)]),
              const SizedBox(height: 10),
              view,
            ]);
          }),
          if (presets.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('Kỳ nhanh:', style: context.tt.bodySmall?.copyWith(fontSize: 13)),
              for (final p in presets)
                _PresetChip(label: p.label, on: p.from == activeFrom && p.to == activeTo, onTap: () => onPreset(p)),
            ]),
          ],
        ]),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  const _DateField({required this.label, required this.value, required this.onTap});
  final String label;
  final String? value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: InputDecorator(
            decoration: const InputDecoration(suffixIcon: Icon(Icons.calendar_today_rounded, size: 18)),
            child: Text(value == null ? label : fmtDay(value!),
                style: TextStyle(fontFeatures: tabular, color: value == null ? context.co.muted : context.cs.onSurface)),
          ),
        ),
      ),
    );
  }
}

class _PresetChip extends StatelessWidget {
  const _PresetChip({required this.label, required this.on, required this.onTap});
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: on ? context.co.infoTint : context.cs.surface,
      shape: StadiumBorder(side: BorderSide(color: on ? Palette.navyAccent : context.co.line)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          child: Text(label,
              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: on ? Palette.navy : context.cs.onSurface)),
        ),
      ),
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.totals});
  final ReconRow totals;

  @override
  Widget build(BuildContext context) {
    return StatGrid(children: [
      StatCard(label: 'Nợ đầu kỳ', value: money(totals.opening)),
      StatCard(label: 'Phát sinh tăng', value: '+${money(totals.increase)}', valueColor: context.co.bad),
      StatCard(label: 'Đã thu / giảm', value: '−${money(totals.decrease)}', valueColor: context.co.good),
      _NavyTotal(label: 'Nợ cuối kỳ', value: money(totals.closing)),
    ]);
  }
}

/// The navy 'Nợ cuối kỳ' card with an amber value; same paddings and type as StatCard so the row lines up.
class _NavyTotal extends StatelessWidget {
  const _NavyTotal({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Palette.navyDarker,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: Palette.navyDarker)),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(label.toUpperCase(), style: context.tt.labelSmall?.copyWith(color: Palette.navyMuted), maxLines: 2),
          const SizedBox(height: 4),
          Text(value, style: context.tt.headlineSmall?.copyWith(fontWeight: FontWeight.w700, fontFeatures: tabular, color: _amber300)),
        ]),
      ),
    );
  }
}

String _plus(num v) => v != 0 ? '+${money(v)}' : '—';
String _minus(num v) => v != 0 ? '−${money(v)}' : '—';

/// Phone: rtable card (title = name + phone; 4 money rows; 'Biên bản').
class _ReconCard extends ConsumerWidget {
  const _ReconCard({required this.row, required this.from, required this.to});
  final ReconRow row;
  final String from;
  final String to;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = row;
    const numStyle = TextStyle(fontFeatures: tabular, fontSize: 14.5);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => openCustomerDetail(context, r.id),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            LinkText(r.name, bold: true, size: 16),
            if (r.phone != null) Text(r.phone!, style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
            const SizedBox(height: 6),
            KeyValueRow(label: 'Nợ đầu kỳ', child: Text(money(r.opening), style: numStyle)),
            KeyValueRow(label: 'Phát sinh tăng', child: Text(_plus(r.increase), style: numStyle.copyWith(color: context.co.bad))),
            KeyValueRow(label: 'Đã thu / giảm', child: Text(_minus(r.decrease), style: numStyle.copyWith(color: context.co.good))),
            KeyValueRow(
              label: 'Nợ cuối kỳ',
              child: Text(money(r.closing),
                  style: numStyle.copyWith(fontWeight: FontWeight.w700, color: r.closing > 0 ? Palette.navyDarker : context.co.muted)),
            ),
            const Divider(height: 14),
            Align(
              alignment: Alignment.centerRight,
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(minimumSize: const Size(64, 38), foregroundColor: Palette.navy),
                onPressed: () => openStatement(context, ref, r.id, from: from, to: to),
                icon: const Icon(Icons.receipt_long_outlined, size: 17),
                label: const Text('Biên bản'),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// Tablet: the web table with the 'Tổng cộng ({n} khách)' footer.
class _ReconTable extends ConsumerWidget {
  const _ReconTable({required this.data});
  final Reconciliation data;

  static const _flex = [28, 16, 16, 16, 16];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final head = context.tt.labelSmall;
    Widget th(String t, int flex, {bool end = true}) =>
        Expanded(flex: flex, child: Text(t.toUpperCase(), style: head, textAlign: end ? TextAlign.right : TextAlign.left));
    Widget cell(String text, int flex, {Color? color, bool bold = false}) => Expanded(
          flex: flex,
          child: Text(text,
              textAlign: TextAlign.right,
              style: TextStyle(fontFeatures: tabular, color: color, fontWeight: bold ? FontWeight.w700 : FontWeight.w500)),
        );
    final t = data.totals;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(children: [
        Container(
          color: Palette.milk50,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(children: [
            th('Khách hàng', _flex[0], end: false),
            th('Nợ đầu kỳ', _flex[1]),
            th('Phát sinh tăng', _flex[2]),
            th('Đã thu / giảm', _flex[3]),
            th('Nợ cuối kỳ', _flex[4]),
            const SizedBox(width: 132),
          ]),
        ),
        const Divider(),
        for (var i = 0; i < data.rows.length; i++) ...[
          if (i > 0) const Divider(),
          Builder(builder: (context) {
            final r = data.rows[i];
            return InkWell(
              onTap: () => openCustomerDetail(context, r.id),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Row(children: [
                  Expanded(
                    flex: _flex[0],
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      LinkText(r.name, bold: true),
                      if (r.phone != null) Text(r.phone!, style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
                    ]),
                  ),
                  cell(money(r.opening), _flex[1]),
                  cell(_plus(r.increase), _flex[2], color: context.co.bad),
                  cell(_minus(r.decrease), _flex[3], color: context.co.good),
                  cell(money(r.closing), _flex[4], bold: true, color: r.closing > 0 ? Palette.navyDarker : context.co.muted),
                  SizedBox(
                    width: 132,
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                            minimumSize: const Size(60, 36), padding: const EdgeInsets.symmetric(horizontal: 12), foregroundColor: Palette.navy),
                        onPressed: () => openStatement(context, ref, r.id, from: data.from, to: data.to),
                        icon: const Icon(Icons.receipt_long_outlined, size: 16),
                        label: const Text('Biên bản', style: TextStyle(fontSize: 13)),
                      ),
                    ),
                  ),
                ]),
              ),
            );
          }),
        ],
        Container(
          decoration: const BoxDecoration(color: Palette.milk50, border: Border(top: BorderSide(color: Palette.navy, width: 2))),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(children: [
            Expanded(
              flex: _flex[0],
              child: Text('Tổng cộng (${data.rows.length} khách)', style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
            cell(money(t.opening), _flex[1], bold: true),
            cell('+${money(t.increase)}', _flex[2], color: context.co.bad, bold: true),
            cell('−${money(t.decrease)}', _flex[3], color: context.co.good, bold: true),
            cell(money(t.closing), _flex[4], color: Palette.navyDarker, bold: true),
            const SizedBox(width: 132),
          ]),
        ),
      ]),
    );
  }
}
