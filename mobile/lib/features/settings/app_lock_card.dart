import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/security/app_lock.dart';
import '../../core/widgets/common.dart';

/// Settings > "Khóa ứng dụng": ask for the phone's fingerprint / face / PIN when the app opens and after it was away.
class AppLockCard extends ConsumerWidget {
  const AppLockCard({super.key});

  String _label(int m) => m == 0 ? 'Mỗi lần mở lại' : '$m phút';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(appLockProvider);
    return SectionCard(
      title: 'Khóa ứng dụng',
      subtitle: 'Hỏi vân tay, khuôn mặt hoặc mã khóa máy khi mở ứng dụng, để người khác cầm máy không dùng được tài khoản đang đăng nhập.',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Bật khóa ứng dụng'),
          value: lock.enabled,
          onChanged: (on) async {
            final n = ref.read(appLockProvider.notifier);
            if (!on) return n.disable();
            final ok = await n.enable();
            if (!ok && context.mounted) showToast(context, 'Không bật được: máy chưa đặt khóa màn hình, hoặc xác nhận không thành công.', error: true);
          },
        ),
        if (lock.enabled) ...[
          const SizedBox(height: 8),
          const Text('Khóa lại sau khi ứng dụng ở nền'),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            for (final m in kLockMinuteChoices)
              ChoiceChip(label: Text(_label(m)), selected: lock.minutes == m, onSelected: (_) => ref.read(appLockProvider.notifier).setMinutes(m)),
          ]),
        ],
      ]),
    );
  }
}
