import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';

/// Sign-in, styled like the web login (views/login.ejs): navy brand panel, white form card, amber button.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _busy = false;
  bool _hide = true;
  String? _error;

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authProvider.notifier).login(_user.text, _pass.text);
    } catch (e) {
      setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _editServer() async {
    final ctrl = TextEditingController(text: ref.read(serverUrlProvider));
    final url = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Địa chỉ máy chủ'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(controller: ctrl, keyboardType: TextInputType.url, autocorrect: false, decoration: const InputDecoration(hintText: kDefaultServer)),
          const SizedBox(height: 8),
          Text('Máy ảo Android chạy cùng máy tính: http://10.0.2.2:3000', style: ctx.tt.bodySmall),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, kDefaultServer), child: const Text('Mặc định')),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Lưu')),
        ],
      ),
    );
    if (url != null && isServerUrlAllowed(url)) await ref.read(serverUrlProvider.notifier).set(url);
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);
    final server = ref.watch(serverUrlProvider);
    final notice = _error ?? (auth is SignedOut ? auth.message : null);
    return Scaffold(
      backgroundColor: Palette.navyDarker,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(children: [
                Container(
                  width: 72,
                  height: 72,
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: const Color(0xFFFBF6EF), borderRadius: BorderRadius.circular(16)),
                  child: Image.network('$server/brand/mark.png', errorBuilder: (_, _, _) => const Icon(Icons.local_cafe_rounded, color: Palette.navy, size: 36)),
                ),
                const SizedBox(height: 14),
                const Text('Tasotek FnB', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                const Text('Đăng nhập để quản lý quán', style: TextStyle(color: Palette.navyMuted, fontSize: 15)),
                const SizedBox(height: 24),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Form(
                      key: _form,
                      child: AutofillGroup(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          if (notice != null) ...[
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(color: context.co.badTint, borderRadius: BorderRadius.circular(10)),
                              child: Text(notice, style: TextStyle(color: context.co.bad)),
                            ),
                            const SizedBox(height: 14),
                          ],
                          const Text('Tên đăng nhập', style: TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 6),
                          TextFormField(
                            controller: _user,
                            autofillHints: const [AutofillHints.username],
                            textInputAction: TextInputAction.next,
                            autocorrect: false,
                            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên đăng nhập' : null,
                          ),
                          const SizedBox(height: 14),
                          const Text('Mật khẩu', style: TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 6),
                          TextFormField(
                            controller: _pass,
                            obscureText: _hide,
                            autofillHints: const [AutofillHints.password],
                            onFieldSubmitted: (_) => _submit(),
                            validator: (v) => (v ?? '').isEmpty ? 'Nhập mật khẩu' : null,
                            decoration: InputDecoration(
                              suffixIcon: IconButton(
                                tooltip: _hide ? 'Hiện mật khẩu' : 'Ẩn mật khẩu',
                                icon: Icon(_hide ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                                onPressed: () => setState(() => _hide = !_hide),
                              ),
                            ),
                          ),
                          const SizedBox(height: 20),
                          FilledButton(
                            onPressed: _busy ? null : _submit,
                            child: _busy
                                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                                : const Text('Đăng nhập'),
                          ),
                        ]),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                TextButton.icon(
                  onPressed: _editServer,
                  icon: const Icon(Icons.dns_outlined, size: 18, color: Palette.navyMuted),
                  label: Text(server.replaceFirst(RegExp(r'^https?://'), ''), style: const TextStyle(color: Palette.navyMuted)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
