import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../menu/form_sheet.dart';
import 'settings_models.dart';

/// user-dialog "Thêm tài khoản": POST /api/admin/users { full_name, username, role, password }. Pops the username.
class UserForm extends ConsumerStatefulWidget {
  const UserForm({super.key});

  @override
  ConsumerState<UserForm> createState() => _UserFormState();
}

class _UserFormState extends ConsumerState<UserForm> {
  final _form = GlobalKey<FormState>();
  final _fullName = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();
  String _role = 'cashier';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _fullName.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final username = _username.text.trim().toLowerCase();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).post('/admin/users', {
        'full_name': _fullName.text.trim(),
        'username': username,
        'role': _role,
        'password': _password.text,
      });
      if (mounted) Navigator.of(context).pop(username);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FormSheet(
      formKey: _form,
      title: 'Thêm tài khoản',
      submitLabel: 'Tạo tài khoản',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        LabeledField(
          label: 'Họ tên',
          child: TextFormField(
            controller: _fullName,
            maxLength: 100,
            buildCounter: noCounter,
            textInputAction: TextInputAction.next,
            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập họ tên' : null,
          ),
        ),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: LabeledField(
              label: 'Tên đăng nhập',
              child: TextFormField(
                controller: _username,
                maxLength: 50,
                buildCounter: noCounter,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontFamily: 'monospace'),
                validator: (v) => RegExp(r'^[a-z0-9][a-z0-9._-]{2,49}$').hasMatch((v ?? '').trim().toLowerCase())
                    ? null
                    : 'Tên đăng nhập 3–50 ký tự: chữ thường, số, dấu . _ -',
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: LabeledField(
              label: 'Vai trò',
              child: DropdownButtonFormField<String>(
                initialValue: _role,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(value: 'cashier', child: Text('Thu ngân')),
                  DropdownMenuItem(value: 'admin', child: Text('Quản trị viên')),
                ],
                onChanged: (v) => setState(() => _role = v ?? 'cashier'),
              ),
            ),
          ),
        ]),
        LabeledField(
          label: 'Mật khẩu (tối thiểu 10 ký tự)',
          child: TextFormField(
            controller: _password,
            obscureText: true,
            maxLength: 200,
            buildCounter: noCounter,
            autofillHints: const [AutofillHints.newPassword],
            validator: passwordRule,
          ),
        ),
        Text('Thu ngân đăng nhập bằng ứng dụng POS; chỉ quản trị viên vào được trang quản trị này.', style: context.tt.bodySmall),
      ],
    );
  }
}

/// reset-dialog "Đặt lại mật khẩu — {username}": PUT /api/admin/users/:id/password { password }. Pops true.
class ResetPasswordForm extends ConsumerStatefulWidget {
  const ResetPasswordForm({super.key, required this.user});
  final StaffUser user;

  @override
  ConsumerState<ResetPasswordForm> createState() => _ResetPasswordFormState();
}

class _ResetPasswordFormState extends ConsumerState<ResetPasswordForm> {
  final _form = GlobalKey<FormState>();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).put('/admin/users/${widget.user.id}/password', {'password': _password.text});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      final err = toApiException(e);
      if (mounted) setState(() => _error = err.code == 'DEMO_ACCOUNT' ? 'Tài khoản demo không đổi được mật khẩu.' : err.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FormSheet(
      formKey: _form,
      title: 'Đặt lại mật khẩu — ${widget.user.username}',
      submitLabel: 'Đặt lại',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        LabeledField(
          label: 'Mật khẩu mới (tối thiểu 10 ký tự)',
          child: TextFormField(
            controller: _password,
            obscureText: true,
            maxLength: 200,
            buildCounter: noCounter,
            autofillHints: const [AutofillHints.newPassword],
            validator: passwordRule,
          ),
        ),
      ],
    );
  }
}

/// Same rule as checkNewPassword on the server (>= 10 characters after trimming).
String? passwordRule(String? v) => (v ?? '').trim().length < 10 ? 'Mật khẩu mới phải có ít nhất 10 ký tự.' : null;

Widget? noCounter(BuildContext context, {required int currentLength, required bool isFocused, required int? maxLength}) => null;
