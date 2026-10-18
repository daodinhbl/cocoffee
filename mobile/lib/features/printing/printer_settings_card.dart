import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'printer_service.dart';

/// Settings > "Máy in Bluetooth": pick the paired thermal printer of this phone and print a test page.
class PrinterSettingsCard extends ConsumerStatefulWidget {
  const PrinterSettingsCard({super.key});
  @override
  ConsumerState<PrinterSettingsCard> createState() => _PrinterSettingsCardState();
}

class _PrinterSettingsCardState extends ConsumerState<PrinterSettingsCard> {
  bool _busy = false;
  int _paper = 80;

  Future<void> _pick() async {
    setState(() => _busy = true);
    try {
      final list = await ref.read(printerServiceProvider).paired();
      if (!mounted) return;
      if (list.isEmpty) {
        showToast(context, 'Chưa có máy in nào được ghép đôi. Ghép đôi máy in trong Cài đặt Bluetooth của điện thoại trước.', error: true);
        return;
      }
      final d = await showModalBottomSheet<PrinterDevice>(
        context: context,
        showDragHandle: true,
        builder: (ctx) => SafeArea(
          child: ListView(shrinkWrap: true, children: [
            const Padding(padding: EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('Chọn máy in', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 17))),
            for (final p in list)
              ListTile(leading: const Icon(Icons.print_rounded), title: Text(p.name), subtitle: Text(p.address), onTap: () => Navigator.pop(ctx, p)),
          ]),
        ),
      );
      if (d != null) await ref.read(savedPrinterProvider.notifier).choose(d);
    } catch (e) {
      if (mounted) showToast(context, printErrorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _test() async {
    setState(() => _busy = true);
    try {
      await ref.read(printerServiceProvider).printTest(paperMm: _paper);
      if (mounted) showToast(context, 'Đã gửi trang in thử.');
    } catch (e) {
      if (mounted) showToast(context, printErrorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final saved = ref.watch(savedPrinterProvider);
    return SectionCard(
      title: 'Máy in Bluetooth',
      subtitle: 'In hóa đơn trực tiếp từ điện thoại này (máy in nhiệt 58/80 mm).',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(saved == null ? Icons.print_disabled_outlined : Icons.print_rounded, color: saved == null ? context.co.muted : context.co.good),
          const SizedBox(width: 10),
          Expanded(child: Text(saved == null ? 'Chưa chọn máy in' : '${saved.name}\n${saved.address}')),
        ]),
        const SizedBox(height: 12),
        SegmentedButton<int>(
          segments: const [ButtonSegment(value: 58, label: Text('Giấy 58 mm')), ButtonSegment(value: 80, label: Text('Giấy 80 mm'))],
          selected: {_paper},
          onSelectionChanged: (s) => setState(() => _paper = s.first),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(onPressed: _busy ? null : _pick, icon: const Icon(Icons.bluetooth_searching_rounded), label: Text(saved == null ? 'Chọn máy in' : 'Đổi máy in')),
          OutlinedButton.icon(onPressed: _busy || saved == null ? null : _test, icon: const Icon(Icons.receipt_long_rounded), label: const Text('In thử Bluetooth')),
          if (saved != null) TextButton(onPressed: _busy ? null : () => ref.read(savedPrinterProvider.notifier).forget(), child: const Text('Bỏ chọn')),
        ]),
      ]),
    );
  }
}
