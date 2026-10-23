import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_client.dart';
import '../../core/offline/offline_db.dart' show foldVi;
import '../../core/theme/app_theme.dart';
import 'onboarding_service.dart';
import 'onboarding_widgets.dart';

/// "Quán Cà Phê Mộc" -> "quan-ca-phe-moc": a sub-domain suggestion (3-30 chars, like the server's SLUG_RE).
String slugFrom(String name) {
  final s = foldVi(name).replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
  final cut = s.length > 30 ? s.substring(0, 30).replaceAll(RegExp(r'-+$'), '') : s;
  return cut;
}

/// "Tạo quán mới": the app twin of the web's /dang-ky. The shop gets its own address `<slug>.<base domain>` and its
/// own database on the server; on success the app switches to that address and signs in with the new admin account.
/// A sign-up that has to wait for a database is remembered and can be checked again from the welcome page.
class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _slug = TextEditingController();
  final _owner = TextEditingController();
  final _email = TextEditingController();
  final _phone = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  final _pass2 = TextEditingController();
  bool _slugTouched = false;
  bool _busy = false;
  bool _hide = true;
  String? _error;
  String? _field; // the input the server's error belongs to
  ({bool ok, String message})? _slugCheck;
  Timer? _debounce;
  int _checkSeq = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    for (final c in [_name, _slug, _owner, _email, _phone, _user, _pass, _pass2]) {
      c.dispose();
    }
    super.dispose();
  }

  void _nameChanged(String v) {
    if (_slugTouched) return;
    _slug.text = slugFrom(v);
    _scheduleCheck();
  }

  void _scheduleCheck() {
    _debounce?.cancel();
    setState(() => _slugCheck = null);
    final slug = _slug.text.trim().toLowerCase();
    if (slug.length < 3) return;
    _debounce = Timer(const Duration(milliseconds: 500), () async {
      final seq = ++_checkSeq;
      try {
        final r = await checkSlug(ref.read(signupApiProvider), slug);
        if (mounted && seq == _checkSeq) setState(() => _slugCheck = r);
      } catch (_) {
        // the check is a convenience: the sign-up itself validates again
      }
    });
  }

  String? _serverError(String field) => _field == field ? _error : null;

  Future<void> _submit() async {
    setState(() {
      _error = null;
      _field = null;
    });
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    final form = SignupForm(
      name: _name.text,
      slug: _slug.text,
      ownerName: _owner.text,
      email: _email.text,
      phone: _phone.text,
      username: _user.text,
      password: _pass.text,
      password2: _pass2.text,
    );
    try {
      final pending = await createServerShop(ref, form);
      if (!mounted) return;
      if (pending != null) {
        setState(() => _busy = false);
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Đã nhận đăng ký'),
            content: Text(
              'Quán “${pending.name}” (${pending.url.replaceFirst('https://', '')}) đã được lưu và đang chờ cấp cơ sở dữ liệu riêng. '
              'Việc này thường xong trong ít giờ; bạn sẽ nhận email khi quán sẵn sàng.\n\n'
              'Sau đó mở ứng dụng, bấm “Kiểm tra lại” ở trang đầu và đăng nhập bằng tài khoản ${pending.username}.',
            ),
            actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Đã hiểu'))],
          ),
        );
        if (mounted) context.go('/welcome');
      }
      // Active: signed in on the new shop; the router opens its home screen.
    } on ApiException catch (e) {
      final field = errorField(e);
      setState(() {
        _error = e.message;
        _field = field;
      });
      if (field != null) _form.currentState?.validate();
    } catch (e) {
      setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = ref.watch(signupInfoProvider);
    final domain = info.whenOrNull(data: (i) => i.baseDomain) ?? '';
    final closed = info.whenOrNull(data: (i) => !i.open) ?? false;
    final unavailable = info.hasError;
    return OnboardingFrame(
      title: 'Tạo quán mới',
      subtitle: 'Quán có địa chỉ riêng và dữ liệu lưu trên máy chủ',
      onBack: () => context.go('/welcome'),
      maxWidth: 520,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: closed || unavailable
              ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  FormNotice(closed
                      ? 'Đăng ký quán mới đang tạm đóng. Vui lòng quay lại sau, hoặc chọn “Dùng trên máy này”.'
                      : 'Không kết nối được máy chủ đăng ký. ${toApiException(info.error!).message}'),
                  const SizedBox(height: 10),
                  OutlinedButton(onPressed: () => ref.invalidate(signupInfoProvider), child: const Text('Thử lại')),
                ])
              : Form(
                  key: _form,
                  child: AutofillGroup(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      if (_error != null && _field == null) FormNotice(_error!),
                      const FormHeading('1. Quán'),
                      const FieldLabel('Tên quán'),
                      TextFormField(
                        key: const ValueKey('signup-name'),
                        controller: _name,
                        maxLength: 80,
                        textInputAction: TextInputAction.next,
                        onChanged: _nameChanged,
                        validator: (v) => (v ?? '').trim().length < 2 ? 'Tên quán cần 2-80 ký tự.' : _serverError('name'),
                      ),
                      const FieldLabel('Địa chỉ riêng của quán', hint: '3-30 ký tự: chữ thường không dấu, số và dấu gạch ngang.'),
                      TextFormField(
                        key: const ValueKey('signup-slug'),
                        controller: _slug,
                        maxLength: 30,
                        autocorrect: false,
                        keyboardType: TextInputType.url,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(suffixText: domain.isEmpty ? null : '.$domain'),
                        onChanged: (_) {
                          _slugTouched = true;
                          _scheduleCheck();
                        },
                        validator: (v) => RegExp(r'^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$').hasMatch((v ?? '').trim().toLowerCase())
                            ? _serverError('slug')
                            : 'Tên miền phụ gồm 3-30 ký tự: chữ thường, số và dấu gạch ngang.',
                      ),
                      if (_slugCheck != null)
                        Text(_slugCheck!.message,
                            key: const ValueKey('signup-slug-check'),
                            style: TextStyle(color: _slugCheck!.ok ? context.co.good : context.co.bad, fontSize: 13)),
                      const FormHeading('2. Chủ quán'),
                      const FieldLabel('Họ và tên'),
                      TextFormField(
                        key: const ValueKey('signup-owner'),
                        controller: _owner,
                        maxLength: 80,
                        autofillHints: const [AutofillHints.name],
                        textInputAction: TextInputAction.next,
                        validator: (v) => (v ?? '').trim().length < 2 ? 'Họ tên chủ quán cần 2-80 ký tự.' : _serverError('ownerName'),
                      ),
                      const FieldLabel('Email'),
                      TextFormField(
                        key: const ValueKey('signup-email'),
                        controller: _email,
                        maxLength: 120,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        autocorrect: false,
                        textInputAction: TextInputAction.next,
                        validator: (v) => RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch((v ?? '').trim()) ? _serverError('email') : 'Email không hợp lệ.',
                      ),
                      const FieldLabel('Số điện thoại (không bắt buộc)'),
                      TextFormField(
                        key: const ValueKey('signup-phone'),
                        controller: _phone,
                        maxLength: 20,
                        keyboardType: TextInputType.phone,
                        autofillHints: const [AutofillHints.telephoneNumber],
                        textInputAction: TextInputAction.next,
                        validator: (v) {
                          final s = (v ?? '').trim();
                          return s.isEmpty || RegExp(r'^[0-9+\s.-]{8,20}$').hasMatch(s) ? _serverError('phone') : 'Số điện thoại không hợp lệ.';
                        },
                      ),
                      const FormHeading('3. Tài khoản quản trị'),
                      const FieldLabel('Tên đăng nhập'),
                      TextFormField(
                        key: const ValueKey('signup-username'),
                        controller: _user,
                        maxLength: 30,
                        autocorrect: false,
                        autofillHints: const [AutofillHints.newUsername],
                        textInputAction: TextInputAction.next,
                        validator: (v) => validateUsername(v) ?? _serverError('username'),
                      ),
                      const FieldLabel('Mật khẩu', hint: 'Ít nhất 10 ký tự.'),
                      TextFormField(
                        key: const ValueKey('signup-password'),
                        controller: _pass,
                        obscureText: _hide,
                        maxLength: 72,
                        autofillHints: const [AutofillHints.newPassword],
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(
                          suffixIcon: IconButton(
                            tooltip: _hide ? 'Hiện mật khẩu' : 'Ẩn mật khẩu',
                            icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                            onPressed: () => setState(() => _hide = !_hide),
                          ),
                        ),
                        validator: (v) => (v ?? '').length < 10 ? 'Mật khẩu cần 10-72 ký tự.' : _serverError('password'),
                      ),
                      const FieldLabel('Nhập lại mật khẩu'),
                      TextFormField(
                        key: const ValueKey('signup-password2'),
                        controller: _pass2,
                        obscureText: _hide,
                        maxLength: 72,
                        onFieldSubmitted: (_) => _submit(),
                        validator: (v) => v != _pass.text ? 'Hai lần nhập mật khẩu chưa giống nhau.' : _serverError('password2'),
                      ),
                      const SizedBox(height: 12),
                      Text.rich(
                        TextSpan(children: [
                          const TextSpan(text: 'Khi tạo quán, bạn đồng ý với '),
                          WidgetSpan(
                            alignment: PlaceholderAlignment.baseline,
                            baseline: TextBaseline.alphabetic,
                            child: InkWell(
                              onTap: () => launchUrl(Uri.parse('$kSignupServer/privacy'), mode: LaunchMode.externalApplication),
                              child: Text('Chính sách quyền riêng tư', style: TextStyle(color: context.cs.primary, decoration: TextDecoration.underline)),
                            ),
                          ),
                          const TextSpan(text: '. Bạn có thể xóa quán và toàn bộ dữ liệu bất cứ lúc nào trong Cài đặt.'),
                        ]),
                        style: context.tt.bodySmall,
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        key: const ValueKey('signup-submit'),
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                            : const Text('Tạo quán'),
                      ),
                    ]),
                  ),
                ),
        ),
      ),
    );
  }
}
