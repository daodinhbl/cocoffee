import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/widgets/common.dart';
import 'settings_models.dart';

/// "Trợ lý Heli (ChatGPT)": the OpenAI key and model of the voice assistant. GET /api/admin/settings -> heli
/// { enabled, source: settings|env|'', hint, model, models }; PUT /admin/settings/heli { api_key?, model?, clear? };
/// POST /admin/settings/heli/test. The key is write-only: the server never sends it back, only its last 4 characters.
class HeliSetting {
  const HeliSetting({required this.enabled, required this.source, required this.hint, required this.model, required this.models});

  factory HeliSetting.fromJson(Map<String, dynamic> j) => HeliSetting(
        enabled: j['enabled'] == true,
        source: '${j['source'] ?? ''}',
        hint: '${j['hint'] ?? ''}',
        model: '${j['model'] ?? ''}',
        models: [for (final m in (j['models'] as List? ?? const [])) '$m'],
      );

  final bool enabled;
  final String source, hint, model;
  final List<String> models;
}

class HeliCard extends ConsumerStatefulWidget {
  const HeliCard({super.key, required this.setting});
  final HeliSetting setting;
  @override
  ConsumerState<HeliCard> createState() => _HeliCardState();
}

class _HeliCardState extends ConsumerState<HeliCard> {
  final _key = TextEditingController();
  late String _model = widget.setting.model;
  bool _busy = false;
  bool _show = false;

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action, String success) async {
    setState(() => _busy = true);
    final ok = await runWithToast(context, action, success: success);
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) _key.clear();
  }

  Future<void> _save() => _run(() async {
        final body = <String, dynamic>{'model': _model};
        if (_key.text.trim().isNotEmpty) body['api_key'] = _key.text.trim();
        await ref.read(apiProvider).put('/admin/settings/heli', body);
        ref.invalidate(adminSettingsProvider);
      }, 'Đã lưu cấu hình trợ lý Heli.');

  Future<void> _test() async {
    setState(() => _busy = true);
    String? hint;
    final ok = await runWithToast(context, () async {
      final res = await ref.read(apiProvider).post('/admin/settings/heli/test', {if (_key.text.trim().isNotEmpty) 'api_key': _key.text.trim()});
      hint = res['hint'] as String?;
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) showToast(context, 'Khóa API hợp lệ${hint == null ? '' : ' ($hint)'}.');
  }

  Future<void> _clear() => _run(() async {
        await ref.read(apiProvider).put('/admin/settings/heli', {'clear': true});
        ref.invalidate(adminSettingsProvider);
      }, 'Đã xóa khóa đã lưu.');

  @override
  Widget build(BuildContext context) {
    final s = widget.setting;
    return SectionCard(
      title: 'Trợ lý Heli (ChatGPT)',
      subtitle: 'Khóa API OpenAI cho trợ lý giọng nói. Lấy khóa ở platform.openai.com/api-keys. Khóa lưu ở đây được ưu tiên hơn biến môi trường và không hiện lại sau khi lưu.',
      trailing: StatusBadge(s.enabled ? 'Đang bật' : 'Chưa có khóa', tone: s.enabled ? Tone.good : Tone.neutral),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (s.hint.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('Đang dùng khóa ${s.hint} (${s.source == 'settings' ? 'đã lưu trong Cài đặt' : 'biến môi trường'})'),
          ),
        TextField(
          controller: _key,
          enabled: !_busy,
          obscureText: !_show,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(
            labelText: s.hint.isEmpty ? 'Khóa API (sk-…)' : 'Khóa mới (để trống để giữ khóa hiện tại)',
            suffixIcon: IconButton(icon: Icon(_show ? Icons.visibility_off_rounded : Icons.visibility_rounded), onPressed: () => setState(() => _show = !_show)),
          ),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: s.models.contains(_model) ? _model : null,
          decoration: const InputDecoration(labelText: 'Mô hình trả lời'),
          items: [for (final m in s.models) DropdownMenuItem(value: m, child: Text(m))],
          onChanged: _busy ? null : (v) => setState(() => _model = v ?? _model),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(onPressed: _busy ? null : _save, icon: const Icon(Icons.save_rounded), label: const Text('Lưu')),
          OutlinedButton.icon(onPressed: _busy || (_key.text.trim().isEmpty && !s.enabled) ? null : _test, icon: const Icon(Icons.verified_rounded), label: const Text('Kiểm tra khóa')),
          if (s.source == 'settings') TextButton(onPressed: _busy ? null : _clear, child: const Text('Xóa khóa đã lưu')),
        ]),
      ]),
    );
  }
}
