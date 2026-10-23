import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_client.dart';
import '../../core/app_mode.dart';
import '../../core/router.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import '../menu/form_sheet.dart';
import '../onboarding/local_setup_screen.dart';
import '../onboarding/onboarding_service.dart';

/// GET /api/account -> { deletable, shop: { slug, name }, grace_days, reason }: may this account delete its shop here?
/// (Only an admin of a shop created by sign-up.) An older server without the endpoint answers 404: the card then
/// points to the web page.
final accountInfoProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  return ref.watch(apiProvider).get('/account', useCache: false);
}, retry: (_, _) => null);

/// Cài đặt > "Xóa tài khoản và dữ liệu" (Google Play: an app that creates accounts lets people delete them in the
/// app). On a server: an admin of a shop created by sign-up deletes the shop (POST /api/account/delete, password +
/// the shop's sub-domain to confirm); the shop stops at once and its data is purged after the grace period. In local
/// mode: "Xóa toàn bộ dữ liệu trên máy" deletes the phone's database.
class AccountDeletionCard extends ConsumerWidget {
  const AccountDeletionCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(appModeProvider) == AppMode.local) return const _LocalDataCard();
    final user = ref.watch(currentUserProvider);
    final info = user?.isAdmin == true ? ref.watch(accountInfoProvider) : null;
    final webPage = '$kSignupServer/xoa-tai-khoan';
    Widget text(String s) => Text(s, style: context.tt.bodyMedium);
    final link = Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        style: TextButton.styleFrom(padding: EdgeInsets.zero),
        onPressed: () => launchUrl(Uri.parse(webPage), mode: LaunchMode.externalApplication),
        icon: const Icon(Icons.open_in_new_rounded, size: 16),
        label: Text(webPage.replaceFirst('https://', '')),
      ),
    );

    final List<Widget> body;
    if (user == null || !user.isAdmin) {
      body = [
        text('Chỉ chủ quán (tài khoản quản trị) xóa được quán và dữ liệu. Muốn ngừng dùng tài khoản nhân viên của bạn, '
            'hãy nhờ chủ quán khóa tài khoản của bạn trong phần Cài đặt của họ.'),
        link,
      ];
    } else {
      body = info!.when(
        loading: () => [const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator()))],
        error: (e, _) => [
          text('Xóa quán và toàn bộ dữ liệu: gửi yêu cầu trên trang web dưới đây (cần tên đăng nhập và mật khẩu quản trị).'),
          link,
        ],
        data: (j) {
          final shop = j['shop'] is Map ? Map<String, dynamic>.from(j['shop'] as Map) : const <String, dynamic>{};
          final days = j['grace_days'] ?? 30;
          if (j['deletable'] != true) {
            return [
              text('Quán này không được tạo trong ứng dụng (quán của máy chủ riêng hoặc bản cài Windows). Dữ liệu nằm trên máy chủ '
                  'của quán: hãy xóa tại đó, hoặc liên hệ quản trị máy chủ.'),
              link,
            ];
          }
          return [
            text('Xóa quán “${shop['name'] ?? ''}” cùng mọi tài khoản và dữ liệu: thực đơn, đơn hàng, kho, khách hàng, báo cáo, cài đặt. '
                'Quán ngừng hoạt động ngay; dữ liệu bị xóa vĩnh viễn sau $days ngày (liên hệ chúng tôi trong thời gian này nếu đổi ý).'),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                key: const ValueKey('delete-account'),
                style: OutlinedButton.styleFrom(foregroundColor: context.co.bad, side: BorderSide(color: context.co.bad)),
                onPressed: () => _deleteShop(context, ref, '${shop['slug'] ?? ''}', days),
                icon: const Icon(Icons.delete_forever_rounded),
                label: const Text('Xóa quán…'),
              ),
            ),
          ];
        },
      );
    }
    return SectionCard(
      title: 'Xóa tài khoản và dữ liệu',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: body),
    );
  }

  Future<void> _deleteShop(BuildContext context, WidgetRef ref, String slug, Object days) async {
    final done = await showDialog<bool>(context: context, builder: (_) => _DeleteShopDialog(slug: slug));
    if (done != true || !context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Đã nhận yêu cầu xóa'),
        content: Text('Quán $slug đã ngừng hoạt động. Toàn bộ dữ liệu sẽ bị xóa vĩnh viễn sau $days ngày.'),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Đóng'))],
      ),
    );
    // Read up front: signing out closes this screen, and its [ref] with it.
    final auth = ref.read(authProvider.notifier);
    final mode = ref.read(appModeProvider.notifier);
    final router = ref.read(routerProvider);
    await auth.logout();
    await mode.set(AppMode.unset);
    router.go('/welcome');
  }
}

class _DeleteShopDialog extends ConsumerStatefulWidget {
  const _DeleteShopDialog({required this.slug});
  final String slug;

  @override
  ConsumerState<_DeleteShopDialog> createState() => _DeleteShopDialogState();
}

class _DeleteShopDialogState extends ConsumerState<_DeleteShopDialog> {
  final _pass = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _pass.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).post('/account/delete', {'password': _pass.text, 'confirm': _confirm.text.trim()});
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      final x = toApiException(e);
      setState(() => _error = x.code == 'BAD_CREDENTIALS' ? 'Mật khẩu không đúng.' : x.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ready = _pass.text.isNotEmpty && _confirm.text.trim().toLowerCase() == widget.slug;
    return AlertDialog(
      title: const Text('Xóa quán và toàn bộ dữ liệu?'),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_error != null) ...[Text(_error!, style: TextStyle(color: context.co.bad)), const SizedBox(height: 8)],
          const Text('Mật khẩu của bạn'),
          TextField(key: const ValueKey('delete-password'), controller: _pass, obscureText: true, onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          Text('Gõ “${widget.slug}” để xác nhận'),
          TextField(
            key: const ValueKey('delete-confirm'),
            controller: _confirm,
            autocorrect: false,
            onChanged: (_) => setState(() {}),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context, false), child: const Text('Quay lại')),
        FilledButton(
          key: const ValueKey('delete-submit'),
          style: FilledButton.styleFrom(backgroundColor: context.co.bad, foregroundColor: Colors.white),
          onPressed: _busy || !ready ? null : _submit,
          child: const Text('Xóa quán'),
        ),
      ],
    );
  }
}

/// Local mode: what the phone keeps, and "Xóa toàn bộ dữ liệu trên máy".
class _LocalDataCard extends ConsumerWidget {
  const _LocalDataCard();

  Future<void> _wipe(BuildContext context, WidgetRef ref) async {
    if (!await confirmAction(context, 'Xóa toàn bộ dữ liệu quán trên máy này: thực đơn, đơn hàng, doanh thu và tài khoản? Không thể khôi phục.')) return;
    if (!context.mounted) return;
    try {
      await wipeLocalShop(ref);
    } catch (e) {
      if (context.mounted) showToast(context, 'Không xóa được dữ liệu: $e', error: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SectionCard(
      title: 'Dữ liệu trên máy này',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text.rich(TextSpan(children: [
          const TextSpan(text: 'Quán đang dùng không có máy chủ: dữ liệu chỉ nằm trên điện thoại này. '),
          const TextSpan(text: 'Dùng được: ', style: TextStyle(fontWeight: FontWeight.w700)),
          const TextSpan(text: kLocalSupported),
          const TextSpan(text: '\nChưa có: ', style: TextStyle(fontWeight: FontWeight.w700)),
          const TextSpan(text: kLocalUnsupported),
        ]), style: context.tt.bodyMedium),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            key: const ValueKey('wipe-local'),
            style: OutlinedButton.styleFrom(foregroundColor: context.co.bad, side: BorderSide(color: context.co.bad)),
            onPressed: () => _wipe(context, ref),
            icon: const Icon(Icons.delete_forever_rounded),
            label: const Text('Xóa toàn bộ dữ liệu trên máy'),
          ),
        ),
      ]),
    );
  }
}
