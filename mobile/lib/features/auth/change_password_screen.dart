import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../settings/settings_sections.dart';

/// Forced password change, like the web's /admin/settings/password gate: an admin who signed in with a short
/// (factory) password gets a token that only reaches /auth/me and /auth/change-password (403
/// MUST_CHANGE_PASSWORD everywhere else). The router keeps the account here until [PasswordCard] succeeds.
class ChangePasswordScreen extends ConsumerWidget {
  const ChangePasswordScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Đổi mật khẩu'), automaticallyImplyLeading: false),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: context.co.warnTint, borderRadius: BorderRadius.circular(10)),
                  child: Text('Mật khẩu hiện tại quá yếu. Hãy đặt mật khẩu mới (tối thiểu 10 ký tự) để tiếp tục.',
                      style: TextStyle(color: context.co.warn)),
                ),
                if (user != null) ...[
                  const SizedBox(height: 12),
                  Text('${user.fullName} · ${user.username}', style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
                ],
                const SizedBox(height: 16),
                const PasswordCard(),
                const SizedBox(height: 20),
                OutlinedButton.icon(
                  onPressed: () => ref.read(authProvider.notifier).logout(),
                  icon: Icon(Icons.logout_rounded, color: context.co.bad),
                  label: Text('Đăng xuất', style: TextStyle(color: context.co.bad)),
                ),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
