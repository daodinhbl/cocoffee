import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/format.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'finance_data.dart';

const _kindText = {'month': 'Tháng', 'quarter': 'Quý', 'year': 'Năm'};

String _viDay(String iso) => iso.length >= 10 ? '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}' : iso;

/// "Thuế & chi phí": an ESTIMATE for the chosen month / quarter / year from the daily rollups (GET /api/finance/dashboard),
/// the yearly revenue threshold, the period lock, and the tax-book exports. Figures are never a filed return.
class FinanceScreen extends ConsumerWidget {
  const FinanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(financeQueryProvider);
    final dash = ref.watch(financeDashboardProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Thuế & chi phí'), actions: [
        IconButton(tooltip: 'Sổ chi phí', icon: const Icon(Icons.account_balance_wallet_rounded), onPressed: () => context.push('/expenses')),
      ]),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(taxExportsProvider);
          ref.invalidate(financeDashboardProvider);
          await ref.read(financeDashboardProvider.future);
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
          children: [
            SegmentedButton<String>(
              segments: [for (final e in _kindText.entries) ButtonSegment(value: e.key, label: Text(e.value))],
              selected: {q.kind},
              onSelectionChanged: (s) => ref.read(financeQueryProvider.notifier).set(FinanceQuery(s.first, dash.value?.period.from)),
            ),
            const SizedBox(height: 10),
            AsyncBody(
              value: dash,
              onRetry: () => ref.invalidate(financeDashboardProvider),
              data: (d) => _Body(d: d, kind: q.kind),
            ),
          ],
        ),
      ),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.d, required this.kind});
  final FinanceDashboard d;
  final String kind;

  void _go(WidgetRef ref, PeriodRef p) => ref.read(financeQueryProvider.notifier).set(FinanceQuery(kind, p.from));

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = d.period;
    final threshold = _n(d.year['threshold']);
    final through = _n(d.year['through']);
    final exempt = d.year['exempt'] == true;
    final ratio = threshold <= 0 ? 0.0 : (through / threshold).clamp(0, 1).toDouble();
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final finished = p.to.compareTo(today) < 0;
    final status = d.lockStatus;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        IconButton(onPressed: () => _go(ref, d.prev), icon: const Icon(Icons.chevron_left_rounded)),
        Expanded(
          child: Column(children: [
            Text(p.label, style: context.tt.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            Text('${_viDay(p.from)} – ${_viDay(p.to)}', style: context.tt.bodySmall),
          ]),
        ),
        IconButton(onPressed: p.to.compareTo(today) >= 0 ? null : () => _go(ref, d.next), icon: const Icon(Icons.chevron_right_rounded)),
      ]),
      const SizedBox(height: 4),
      Card(
        color: context.co.warnTint,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Text(
            'Số liệu ƯỚC TÍNH từ đơn đã hoàn tất và sổ chi phí, để theo dõi — không phải tờ khai. Thuế suất và ngưỡng cần kế toán xác nhận trước khi nộp.',
            style: TextStyle(color: context.co.warn, fontSize: 13),
          ),
        ),
      ),
      const SizedBox(height: 12),
      Wrap(spacing: 10, runSpacing: 10, children: [
        _Tile(label: 'Doanh thu (sau giảm giá)', value: money(_n(d.revenue['net'])), icon: Icons.trending_up_rounded),
        _Tile(label: 'Chi phí', value: money(_n(d.expenses['total'])), sub: 'được trừ ${money(_n(d.expenses['deductible']))}', icon: Icons.trending_down_rounded),
        _Tile(label: 'Lợi nhuận ước tính', value: money(d.profit), icon: Icons.savings_rounded, tone: d.profit >= 0 ? Tone.good : Tone.bad),
        _Tile(label: 'Thuế ước tính', value: money(d.tax), sub: 'GTGT ${money(d.vat)} · TNCN ${money(d.pit)}', icon: Icons.percent_rounded, tone: d.tax > 0 ? Tone.warn : Tone.neutral),
      ]),
      const SizedBox(height: 12),
      SectionCard(
        title: 'Ngưỡng doanh thu cả năm',
        subtitle: exempt ? 'Chưa vượt ngưỡng: chưa phải nộp thuế theo cấu hình hiện tại' : 'Đã vượt ngưỡng: phần vượt chịu thuế',
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ClipRRect(borderRadius: BorderRadius.circular(6), child: LinearProgressIndicator(value: ratio, minHeight: 10, color: exempt ? context.co.good : context.co.warn)),
          const SizedBox(height: 6),
          Text('${money(through)} / ${money(threshold)} · còn ${money(_n(d.year['remaining']))}', style: context.tt.bodySmall),
          if (d.taxableRevenue > 0) Text('Doanh thu chịu thuế trong kỳ: ${money(d.taxableRevenue)}', style: context.tt.bodySmall),
        ]),
      ),
      const SizedBox(height: 12),
      SectionCard(
        title: 'Theo nhóm thuế',
        child: d.categories.isEmpty
            ? Text('Chưa có doanh thu trong kỳ.', style: context.tt.bodyMedium)
            : Column(children: [
                for (final c in d.categories)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: Text('${c['name']}'),
                    subtitle: Text('GTGT ${money(_n(c['vat']))} · TNCN ${money(_n(c['pit']))}'),
                    trailing: Text(money(_n(c['net_revenue'])), style: const TextStyle(fontWeight: FontWeight.w700)),
                  ),
              ]),
      ),
      const SizedBox(height: 12),
      SectionCard(title: '6 tháng gần nhất', child: _MonthBars(months: d.months)),
      const SizedBox(height: 12),
      _LockCard(d: d, kind: kind, finished: finished, status: status),
      const SizedBox(height: 12),
      _ExportsCard(period: p),
    ]);
  }
}

num _n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

class _Tile extends StatelessWidget {
  const _Tile({required this.label, required this.value, this.sub, required this.icon, this.tone});
  final String label, value;
  final String? sub;
  final IconData icon;
  final Tone? tone;

  @override
  Widget build(BuildContext context) {
    final w = (MediaQuery.sizeOf(context).width - 32 - 10) / 2;
    return SizedBox(width: math.max(150, w), child: StatCard(label: label, value: value, sub: sub, icon: icon, tone: tone));
  }
}

class _MonthBars extends StatelessWidget {
  const _MonthBars({required this.months});
  final List<Map<String, dynamic>> months;

  @override
  Widget build(BuildContext context) {
    final max = months.fold<num>(1, (m, e) => math.max(m, math.max(_n(e['revenue']), _n(e['expenses']))));
    return Column(children: [
      SizedBox(
        height: 130,
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          for (final m in months)
            Expanded(
              child: Tooltip(
                message: '${m['month']}: thu ${money(_n(m['revenue']))}, chi ${money(_n(m['expenses']))}',
                child: Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                  _bar(130 * _n(m['revenue']) / max, context.cs.primary),
                  const SizedBox(width: 3),
                  _bar(130 * _n(m['expenses']) / max, context.co.warn),
                ]),
              ),
            ),
        ]),
      ),
      const SizedBox(height: 4),
      Row(children: [for (final m in months) Expanded(child: Text('${m['month']}'.replaceFirst(RegExp(r'^\d{4}-'), 'T'), textAlign: TextAlign.center, style: context.tt.bodySmall))]),
      const SizedBox(height: 6),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        _dot(context.cs.primary), const Text(' Doanh thu   '), _dot(context.co.warn), const Text(' Chi phí'),
      ]),
    ]);
  }

  Widget _bar(num h, Color c) => Container(width: 12, height: math.max(2, h.toDouble()), decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(3)));
  Widget _dot(Color c) => Container(width: 10, height: 10, decoration: BoxDecoration(color: c, shape: BoxShape.circle));
}

class _LockCard extends ConsumerWidget {
  const _LockCard({required this.d, required this.kind, required this.finished, required this.status});
  final FinanceDashboard d;
  final String kind;
  final bool finished;
  final String? status;

  Future<void> _run(BuildContext context, WidgetRef ref, String action, String ok, {String? filedRef}) async {
    await runWithToast(context, () => ref.read(financeActionsProvider).period(action, kind, d.period.from, ref: filedRef), success: ok);
  }

  Future<void> _markFiled(BuildContext context, WidgetRef ref) async {
    final c = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Đánh dấu đã nộp tờ khai'),
        content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(labelText: 'Số tham chiếu / mã hồ sơ (không bắt buộc)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Thôi')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Đã nộp')),
        ],
      ),
    );
    final text = c.text.trim();
    c.dispose();
    if (ok == true && context.mounted) await _run(context, ref, 'filed', 'Đã đánh dấu đã nộp.', filedRef: text);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locked = status == 'locked', filed = status == 'filed';
    return SectionCard(
      title: 'Khóa kỳ',
      trailing: StatusBadge(filed ? 'Đã nộp' : locked ? 'Đã khóa' : 'Đang mở', tone: filed ? Tone.good : locked ? Tone.info : Tone.neutral),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          filed
              ? 'Kỳ đã nộp tờ khai${d.filedRef == null || d.filedRef!.isEmpty ? '' : ' (${d.filedRef})'}; không mở khóa được nữa.'
              : locked
                  ? 'Chi phí trong kỳ không thêm / sửa / hủy được cho đến khi mở khóa.'
                  : finished
                      ? 'Khóa kỳ sau khi đã chốt số liệu để khoản chi không bị sửa lén.'
                      : 'Chỉ khóa được kỳ đã kết thúc.',
          style: context.tt.bodyMedium,
        ),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (!locked && !filed) FilledButton.icon(onPressed: finished ? () => _run(context, ref, 'lock', 'Đã khóa kỳ.') : null, icon: const Icon(Icons.lock_rounded), label: const Text('Khóa kỳ')),
          if (locked) OutlinedButton.icon(onPressed: () => _run(context, ref, 'unlock', 'Đã mở khóa.'), icon: const Icon(Icons.lock_open_rounded), label: const Text('Mở khóa')),
          if (locked) FilledButton.icon(onPressed: () => _markFiled(context, ref), icon: const Icon(Icons.task_alt_rounded), label: const Text('Đánh dấu đã nộp')),
        ]),
      ]),
    );
  }
}

class _ExportsCard extends ConsumerWidget {
  const _ExportsCard({required this.period});
  final PeriodRef period;

  Future<void> _create(BuildContext context, WidgetRef ref, String kind) async {
    await runWithToast(context, () async {
      await ref.read(financeActionsProvider).createExport(kind, period.from, period.to);
    }, success: 'Đã xếp hàng tạo “${taxExportKinds[kind]}”. Tải về khi xong.');
  }

  Future<void> _share(BuildContext context, WidgetRef ref, TaxExport e) async {
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null ? null : box.localToGlobal(Offset.zero) & box.size;
    try {
      final f = await ref.read(financeActionsProvider).downloadExport(e);
      await SharePlus.instance.share(ShareParams(files: [XFile(f.path)], subject: taxExportKinds[e.kind], sharePositionOrigin: origin));
    } catch (err) {
      if (context.mounted) showToast(context, '$err'.replaceFirst('ApiException(NOT_FOUND, null): ', ''), error: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(taxExportsProvider);
    return SectionCard(
      title: 'Xuất sổ (.xlsx)',
      subtitle: 'Kỳ ${_viDay(period.from)} – ${_viDay(period.to)}',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final k in taxExportKinds.entries)
            OutlinedButton(onPressed: () => _create(context, ref, k.key), child: Text(k.value)),
        ]),
        const SizedBox(height: 10),
        list.when(
          loading: () => const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator())),
          error: (e, _) => Text(toApiExceptionText(e)),
          data: (items) => items.isEmpty
              ? Text('Chưa có file nào.', style: context.tt.bodySmall)
              : Column(children: [
                  for (final e in items.take(8))
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      title: Text('${taxExportKinds[e.kind] ?? e.kind} · ${_viDay(e.from)} – ${_viDay(e.to)}'),
                      subtitle: Text(e.failed ? (e.error ?? 'Lỗi') : e.running ? 'Đang tạo…' : e.fileBytes == null ? 'Xong' : '${(e.fileBytes! / 1024).round()} KB'),
                      trailing: e.running
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : e.downloadable
                              ? IconButton(tooltip: 'Tải / chia sẻ', icon: const Icon(Icons.ios_share_rounded), onPressed: () => _share(context, ref, e))
                              : Icon(e.failed ? Icons.error_outline_rounded : Icons.history_toggle_off_rounded, color: context.co.muted),
                    ),
                ]),
        ),
        const SizedBox(height: 4),
        Text('File lưu 7 ngày trên máy chủ.', style: context.tt.bodySmall),
      ]),
    );
  }
}

String toApiExceptionText(Object e) => e.toString();
