import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';

Map<String, dynamic> _map(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

/// GET /api/admin/zalo -> { connection, stats, events, drafts, failed, chatbot, banks } (no secrets, not even a token hint).
final zaloOverviewProvider = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiProvider).get('/admin/zalo');
  return _map(res['connection']);
});

/// "Zalo bot": the connection state and the place to paste the Bot Token (write-only: checked with Zalo, stored on the server,
/// never shown again), plus re-registering the webhook. The web page of the same name has the stats and the chat log.
class ZaloScreen extends ConsumerStatefulWidget {
  const ZaloScreen({super.key});
  @override
  ConsumerState<ZaloScreen> createState() => _ZaloScreenState();
}

class _ZaloScreenState extends ConsumerState<ZaloScreen> {
  final _token = TextEditingController();
  bool _busy = false;
  bool _show = false;

  @override
  void dispose() {
    _token.dispose();
    super.dispose();
  }

  Future<void> _saveToken() async {
    final t = _token.text.trim();
    if (t.length < 10) {
      showToast(context, 'Dán đúng Bot Token (lấy ở bot.zaloplatforms.com).', error: true);
      return;
    }
    setState(() => _busy = true);
    String? message;
    final ok = await runWithToast(context, () async {
      final res = await ref.read(apiProvider).put('/admin/zalo/bot-token', {'token': t});
      message = res['message'] as String?;
      ref.invalidate(zaloOverviewProvider);
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _token.clear();
      showToast(context, message ?? 'Đã lưu Bot Token.');
    }
  }

  Future<void> _register() async {
    setState(() => _busy = true);
    String? message;
    final ok = await runWithToast(context, () async {
      final res = await ref.read(apiProvider).post('/admin/zalo/register-webhook');
      message = res['message'] as String?;
      ref.invalidate(zaloOverviewProvider);
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) showToast(context, message ?? 'Đã đăng ký webhook.');
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(zaloOverviewProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Zalo bot')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(zaloOverviewProvider.future),
        child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
          AsyncBody<Map<String, dynamic>>(
            value: conn,
            onRetry: () => ref.invalidate(zaloOverviewProvider),
            data: (c) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [_status(context, c), const SizedBox(height: 12), _tokenCard(context, c)]),
          ),
        ]),
      ),
    );
  }

  Widget _status(BuildContext context, Map<String, dynamic> c) {
    final platform = c['platform'] == true;
    final tokenSet = c['tokenSet'] == true;
    final configured = c['configured'] == true;
    final url = '${c['webhookUrl'] ?? ''}';
    return SectionCard(
      title: 'Kết nối',
      trailing: StatusBadge(configured ? 'Đã cấu hình' : 'Chưa xong', tone: configured ? Tone.good : Tone.warn),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _row(context, 'Chế độ', platform ? 'Zalo Bot Platform' : '${c['mode'] ?? ''}'),
        _row(context, 'Bot Token', tokenSet ? 'Đã có${c['tokenSource'] == 'env' ? ' (đặt ở hPanel)' : ' (lưu trên máy chủ)'}' : 'Chưa có'),
        if ('${c['debtOwnerChatId'] ?? ''}'.isNotEmpty) _row(context, 'Nhận nhắc nợ', '${c['debtOwnerChatId']} (${c['debtOwnerChatType'] ?? 'user'})'),
        const SizedBox(height: 6),
        Text('Webhook', style: context.tt.bodySmall),
        Row(children: [
          Expanded(child: SelectableText(url, style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5))),
          IconButton(
            tooltip: 'Sao chép',
            icon: const Icon(Icons.copy_rounded, size: 18),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: url));
              if (context.mounted) showToast(context, 'Đã sao chép địa chỉ webhook.');
            },
          ),
        ]),
        if (platform && tokenSet) ...[
          const SizedBox(height: 4),
          OutlinedButton.icon(onPressed: _busy ? null : _register, icon: const Icon(Icons.sync_rounded), label: const Text('Đăng ký lại webhook')),
        ],
      ]),
    );
  }

  Widget _row(BuildContext context, String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(k, style: context.tt.bodySmall)),
          Expanded(child: Text(v)),
        ]),
      );

  Widget _tokenCard(BuildContext context, Map<String, dynamic> c) {
    final fromEnv = c['tokenSource'] == 'env';
    return SectionCard(
      title: 'Bot Token Zalo chatbot',
      subtitle: fromEnv
          ? 'Token đang được đặt trong hPanel (ZALO_BOT_TOKEN) nên không sửa ở đây được. Xóa biến đó ở hPanel nếu muốn nhập tại app.'
          : 'Dán token lấy ở bot.zaloplatforms.com. Ứng dụng kiểm tra với Zalo, lưu trên máy chủ và tự đăng ký webhook. Token không hiện lại sau khi lưu.',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          controller: _token,
          enabled: !fromEnv && !_busy,
          obscureText: !_show,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(
            labelText: c['tokenSet'] == true ? 'Token mới (để thay token hiện tại)' : 'Bot Token',
            suffixIcon: IconButton(icon: Icon(_show ? Icons.visibility_off_rounded : Icons.visibility_rounded), onPressed: () => setState(() => _show = !_show)),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: fromEnv || _busy ? null : _saveToken,
          icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.link_rounded),
          label: const Text('Lưu và kết nối'),
        ),
      ]),
    );
  }
}
