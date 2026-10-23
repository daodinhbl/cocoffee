import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/api_client.dart';
import '../../core/app_mode.dart';
import '../../core/theme/app_theme.dart';
import 'onboarding_service.dart';
import 'onboarding_widgets.dart';

/// What works without a server, and what does not (shown before the local shop is created, and in Cài đặt).
const kLocalSupported = 'Thực đơn (nhóm món, món, giá), bán hàng tại POS (mang đi, giữ đơn, thanh toán tiền mặt / chuyển khoản / thẻ, '
    'in hóa đơn Bluetooth), đơn hàng và báo cáo doanh thu theo ngày.';
const kLocalUnsupported = 'Bàn, kho và công thức (BOM), giá vốn và lãi gộp, khách hàng và công nợ, chi phí và thuế, Zalo, trợ lý Heli, '
    'tài khoản nhân viên, ảnh món, trang quản lý web và dùng chung giữa nhiều máy.';

/// "Dùng trên máy này", first run: creates the blank local database with the shop's name, the admin account of
/// this phone and (optionally) a few sample dishes, then signs in.
class LocalSetupScreen extends ConsumerStatefulWidget {
  const LocalSetupScreen({super.key});

  @override
  ConsumerState<LocalSetupScreen> createState() => _LocalSetupScreenState();
}

class _LocalSetupScreenState extends ConsumerState<LocalSetupScreen> {
  final _form = GlobalKey<FormState>();
  final _shop = TextEditingController();
  final _name = TextEditingController();
  final _user = TextEditingController(text: 'admin');
  final _pass = TextEditingController();
  final _pass2 = TextEditingController();
  bool _sample = true;
  bool _busy = false;
  bool _hide = true;
  String? _error;

  @override
  void dispose() {
    for (final c in [_shop, _name, _user, _pass, _pass2]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await createLocalShop(
        ref,
        shopName: _shop.text,
        fullName: _name.text,
        username: _user.text,
        password: _pass.text,
        sampleMenu: _sample,
      );
    } catch (e) {
      // A setup that failed before the shop existed must not leave the app in local mode without one.
      if (!ref.read(localReadyProvider)) await ref.read(appModeProvider.notifier).set(AppMode.unset);
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return OnboardingFrame(
      title: 'Dùng trên máy này',
      subtitle: 'Dữ liệu quán lưu ngay trên điện thoại, không cần máy chủ',
      onBack: () async {
        await chooseAgain(ref);
        if (context.mounted) context.go('/welcome');
      },
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: _form,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_error != null) FormNotice(_error!),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: context.co.infoTint, borderRadius: BorderRadius.circular(10)),
                child: Text.rich(TextSpan(children: [
                  const TextSpan(text: 'Dùng được: ', style: TextStyle(fontWeight: FontWeight.w700)),
                  const TextSpan(text: kLocalSupported),
                  const TextSpan(text: '\nChưa có: ', style: TextStyle(fontWeight: FontWeight.w700)),
                  const TextSpan(text: kLocalUnsupported),
                  const TextSpan(text: '\nGỡ ứng dụng hoặc xóa dữ liệu ứng dụng sẽ mất toàn bộ dữ liệu quán.'),
                ]), style: context.tt.bodySmall),
              ),
              const FormHeading('1. Quán'),
              const FieldLabel('Tên quán'),
              TextFormField(
                key: const ValueKey('local-shop'),
                controller: _shop,
                maxLength: 80,
                textInputAction: TextInputAction.next,
                validator: (v) => (v ?? '').trim().length < 2 ? 'Tên quán cần 2-80 ký tự.' : null,
              ),
              const FormHeading('2. Tài khoản quản trị trên máy này'),
              const FieldLabel('Họ và tên'),
              TextFormField(
                key: const ValueKey('local-name'),
                controller: _name,
                maxLength: 80,
                textInputAction: TextInputAction.next,
                validator: (v) => (v ?? '').trim().length < 2 ? 'Nhập họ tên (2-80 ký tự).' : null,
              ),
              const FieldLabel('Tên đăng nhập'),
              TextFormField(
                key: const ValueKey('local-username'),
                controller: _user,
                maxLength: 30,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                validator: validateUsername,
              ),
              const FieldLabel('Mật khẩu', hint: 'Ít nhất 10 ký tự. Dùng để mở quán trên máy này.'),
              TextFormField(
                key: const ValueKey('local-password'),
                controller: _pass,
                obscureText: _hide,
                maxLength: 72,
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  suffixIcon: IconButton(
                    tooltip: _hide ? 'Hiện mật khẩu' : 'Ẩn mật khẩu',
                    icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                    onPressed: () => setState(() => _hide = !_hide),
                  ),
                ),
                validator: (v) => (v ?? '').length < 10 ? 'Mật khẩu cần ít nhất 10 ký tự.' : null,
              ),
              const FieldLabel('Nhập lại mật khẩu'),
              TextFormField(
                key: const ValueKey('local-password2'),
                controller: _pass2,
                obscureText: _hide,
                maxLength: 72,
                validator: (v) => v != _pass.text ? 'Hai lần nhập mật khẩu chưa giống nhau.' : null,
              ),
              CheckboxListTile(
                key: const ValueKey('local-sample'),
                contentPadding: EdgeInsets.zero,
                value: _sample,
                onChanged: (v) => setState(() => _sample = v ?? false),
                title: const Text('Thêm vài món mẫu (cà phê, trà, đồ ăn vặt)'),
                subtitle: const Text('Sửa hoặc ngừng bán trong Thực đơn bất cứ lúc nào.'),
              ),
              const SizedBox(height: 8),
              FilledButton(
                key: const ValueKey('local-submit'),
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Text('Bắt đầu bán hàng'),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
