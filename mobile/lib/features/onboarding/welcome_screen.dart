import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_client.dart';
import '../../core/app_mode.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'onboarding_service.dart';
import 'onboarding_widgets.dart';

/// First screen of a new install: how will this phone be used?
///  - "Đăng nhập quán có sẵn": staff of a shop that already runs on a server (the login screen);
///  - "Tạo quán mới trên máy chủ": registers a shop and its owner account (POST /api/signup), then signs in;
///  - "Dùng trên máy này": no server, the shop's data stays in a database on the phone.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  bool _checking = false;

  Future<void> _existing() async {
    await ref.read(appModeProvider.notifier).set(AppMode.server);
    if (mounted) context.go('/login');
  }

  Future<void> _local() async {
    if (ref.read(localReadyProvider)) {
      await ref.read(appModeProvider.notifier).set(AppMode.local); // the router opens the local login
    } else if (mounted) {
      context.go('/local-setup');
    }
  }

  Future<void> _checkPending(PendingShop shop) async {
    setState(() => _checking = true);
    try {
      final status = await pendingStatus(ref.read(signupApiProvider), shop.slug);
      if (!mounted) return;
      if (status == 'active') {
        await openServerShop(ref, shop.url);
        if (mounted) {
          showToast(context, 'Quán “${shop.name}” đã sẵn sàng. Đăng nhập bằng tài khoản ${shop.username}.');
          context.go('/login');
        }
      } else if (status == 'pending') {
        showToast(context, 'Quán vẫn đang chờ cấp dữ liệu. Vui lòng thử lại sau.');
      } else {
        await ref.read(pendingShopProvider.notifier).set(null);
        if (mounted) showToast(context, 'Không tìm thấy quán ${shop.slug}. Bạn có thể đăng ký lại.', error: true);
      }
    } catch (e) {
      if (mounted) showToast(context, toApiException(e).message, error: true);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = ref.watch(pendingShopProvider);
    final hasLocal = ref.watch(localReadyProvider);
    return OnboardingFrame(
      title: 'Chào mừng đến POS Tasotek',
      subtitle: 'Bán hàng, thực đơn và doanh thu cho quán F&B. Bạn muốn bắt đầu thế nào?',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (pending != null) ...[
          Card(
            color: context.co.warnTint,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Quán “${pending.name}” đang được chuẩn bị', style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text('${pending.url.replaceFirst('https://', '')} đã đăng ký và đang chờ cấp cơ sở dữ liệu. Khi xong, bạn đăng nhập bằng tài khoản ${pending.username}.'),
                const SizedBox(height: 8),
                OutlinedButton(
                  key: const ValueKey('welcome-check-pending'),
                  onPressed: _checking ? null : () => _checkPending(pending),
                  child: _checking ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Kiểm tra lại'),
                ),
              ]),
            ),
          ),
          const SizedBox(height: 10),
        ],
        _Choice(
          key: const ValueKey('welcome-login'),
          icon: Icons.login_rounded,
          title: 'Đăng nhập quán có sẵn',
          text: 'Quán của bạn đã dùng Tasotek: đăng nhập bằng tài khoản chủ quán hoặc nhân viên.',
          onTap: _existing,
        ),
        _Choice(
          key: const ValueKey('welcome-signup'),
          icon: Icons.add_business_rounded,
          title: 'Tạo quán mới trên máy chủ',
          text: 'Quán có địa chỉ riêng, dữ liệu lưu trên máy chủ, dùng chung cho nhiều máy và trang quản lý web.',
          onTap: () => context.go('/signup'),
        ),
        _Choice(
          key: const ValueKey('welcome-local'),
          icon: Icons.phone_android_rounded,
          title: hasLocal ? 'Mở quán trên máy này' : 'Dùng trên máy này',
          text: hasLocal
              ? 'Tiếp tục với dữ liệu quán đã lưu trên điện thoại này.'
              : 'Không cần máy chủ hay mạng: thực đơn, bán hàng, đơn hàng và doanh thu lưu ngay trên điện thoại.',
          onTap: _local,
        ),
      ]),
    );
  }
}

class _Choice extends StatelessWidget {
  const _Choice({super.key, required this.icon, required this.title, required this.text, required this.onTap});
  final IconData icon;
  final String title;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            CircleAvatar(radius: 22, backgroundColor: Palette.navy, child: Icon(icon, color: Colors.white)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                const SizedBox(height: 2),
                Text(text, style: context.tt.bodySmall?.copyWith(color: context.co.muted)),
              ]),
            ),
            const Icon(Icons.chevron_right_rounded),
          ]),
        ),
      ),
    );
  }
}
