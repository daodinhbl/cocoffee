import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import 'integrations_cards.dart';
import 'settings_models.dart';
import 'settings_sections.dart';

/// Cài đặt (views/pages/settings.ejs) as far as the API goes: account, "Đổi mật khẩu", then for admins
/// "Cấu hình hệ thống" (read-only), "Máy in hóa đơn" and "Tài khoản nhân viên"; then the app's own server
/// address, version and "Đăng xuất". From 840 dp the password and config cards sit side by side (5/12 + 7/12).
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    try {
      await Future.wait([ref.refresh(adminSettingsProvider.future), ref.refresh(staffUsersProvider.future)]);
    } catch (_) {
      // Each section shows its own error with "Thử lại".
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);
    final admin = user?.isAdmin ?? false;

    final list = LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= kTableBreakpoint;
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          PageWidth(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Tài khoản của bạn, nhân sự và cấu hình hệ thống.', style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
              const SizedBox(height: 16),
              if (user != null) ...[_AccountCard(user: user), const SizedBox(height: 16)],
              if (admin && wide)
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: const [
                  Expanded(flex: 5, child: PasswordCard()),
                  SizedBox(width: 16),
                  Expanded(flex: 7, child: _ConfigSection()),
                ])
              else ...[
                const PasswordCard(),
                if (admin) ...[const SizedBox(height: 16), const _ConfigSection()],
              ],
              if (admin) ...[
                const SizedBox(height: 16),
                const _PrinterSection(),
                const SizedBox(height: 16),
                const IntegrationsSection(),
                const SizedBox(height: 24),
                const UsersSection(),
              ],
              const SizedBox(height: 16),
              const AppInfoCard(),
              const SizedBox(height: 20),
              Align(
                alignment: wide ? Alignment.centerLeft : Alignment.center,
                child: SizedBox(
                  width: wide ? 240 : double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: () => ref.read(authProvider.notifier).logout(),
                    icon: Icon(Icons.logout_rounded, color: context.co.bad),
                    label: Text('Đăng xuất', style: TextStyle(color: context.co.bad)),
                  ),
                ),
              ),
            ]),
          ),
        ],
      );
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Cài đặt')),
      body: admin ? RefreshIndicator(onRefresh: () => _refresh(ref), child: list) : list,
    );
  }
}

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.user});
  final AppUser user;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: CircleAvatar(
          backgroundColor: Palette.navy,
          child: Text(user.fullName.isEmpty ? '?' : user.fullName[0].toUpperCase(),
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        ),
        title: Text(user.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(user.username, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
        trailing: StatusBadge(roleLabel(user.role), tone: user.isAdmin ? Tone.info : Tone.neutral),
      ),
    );
  }
}

class _ConfigSection extends ConsumerWidget {
  const _ConfigSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(adminSettingsProvider);
    return settings.when(
      skipLoadingOnRefresh: true,
      skipLoadingOnReload: true,
      data: (s) => ConfigCard(config: s.config),
      loading: () => const SectionCard(title: 'Cấu hình hệ thống', child: Center(child: CircularProgressIndicator())),
      error: (e, _) => SectionCard(
        title: 'Cấu hình hệ thống',
        child: ErrorPanel(error: e, onRetry: () => ref.invalidate(adminSettingsProvider)),
      ),
    );
  }
}

class _PrinterSection extends ConsumerWidget {
  const _PrinterSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(adminSettingsProvider);
    return settings.when(
      skipLoadingOnRefresh: true,
      skipLoadingOnReload: true,
      data: (s) => PrinterCard(printer: s.printer),
      loading: () => const SectionCard(title: 'Máy in hóa đơn', child: Center(child: CircularProgressIndicator())),
      error: (e, _) => SectionCard(
        title: 'Máy in hóa đơn',
        child: ErrorPanel(error: e, onRetry: () => ref.invalidate(adminSettingsProvider)),
      ),
    );
  }
}
