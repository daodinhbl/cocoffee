import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/common.dart';
import 'heli_controller.dart';
import 'heli_state.dart';

const _adminHints = ['Hôm nay bao nhiêu đơn?', 'Doanh thu hôm nay là bao nhiêu?', 'Nguyên liệu nào sắp hết?'];
const _cashierHints = ['Xin chào Heli', 'Heli giúp được gì cho mình?'];

/// "Trợ lý Heli": tap the round mic to speak, or switch on "Gọi Heli" and say "Heli, ..." while this screen is open.
class HeliScreen extends ConsumerStatefulWidget {
  const HeliScreen({super.key});

  @override
  ConsumerState<HeliScreen> createState() => _HeliScreenState();
}

class _HeliScreenState extends ConsumerState<HeliScreen> with WidgetsBindingObserver {
  final _text = TextEditingController();
  final _scroll = ScrollController();
  late final HeliController _ctl;

  @override
  void initState() {
    super.initState();
    _ctl = ref.read(heliProvider.notifier);
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // never listen while the app is not on screen
    if (s != AppLifecycleState.resumed) _ctl.pause();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    Future.microtask(_ctl.pause);
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<bool> _explain() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Cho phép dùng micro'),
        content: const Text('Heli cần micro để nghe câu hỏi của bạn. Âm thanh chỉ được nhận dạng khi bạn bấm micro hoặc bật "Gọi Heli" '
            'và màn hình Heli đang mở; ứng dụng không nghe khi chạy nền.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Để sau')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Tiếp tục')),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<bool> _micReady() async {
    final s = await _ctl.micStatus();
    if (s == MicStatus.granted) return true;
    if (!mounted) return false;
    if (s == MicStatus.permanentlyDenied) {
      final open = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Micro đang bị tắt'),
          content: const Text('Hãy mở Cài đặt ứng dụng, chọn Quyền > Micro > Cho phép, rồi quay lại Heli.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Đóng')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Mở Cài đặt')),
          ],
        ),
      );
      if (open == true) await _ctl.openSettings();
      return false;
    }
    return _explain();
  }

  Future<void> _onMic() async {
    final phase = ref.read(heliProvider).phase;
    if (phase == HeliPhase.listening || phase == HeliPhase.speaking || await _micReady()) await _ctl.tapMic();
  }

  Future<void> _onHandsFree(bool on) async {
    if (!on || await _micReady()) await _ctl.setHandsFree(on);
  }

  void _send([String? preset]) {
    final t = (preset ?? _text.text).trim();
    if (t.isEmpty) return;
    _text.clear();
    _ctl.submit(t);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(heliProvider);
    final isAdmin = ref.watch(currentUserProvider)?.isAdmin ?? false;
    ref.listen(heliProvider.select((x) => x.errorSeq), (_, _) {
      final e = ref.read(heliProvider).error;
      if (e != null && mounted) showToast(context, e, error: true);
    });
    ref.listen(heliProvider.select((x) => x.messages.length), (_, _) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      });
    });
    final hints = isAdmin ? _adminHints : _cashierHints;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Trợ lý Heli'),
        actions: [
          IconButton(
            tooltip: 'Cuộc trò chuyện mới',
            onPressed: s.messages.isEmpty && !s.busy ? null : _ctl.newConversation,
            icon: const Icon(Icons.add_comment_outlined),
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Column(children: [
            _StatusBar(state: s),
            SwitchListTile(
              dense: true,
              secondary: const Icon(Icons.record_voice_over_rounded),
              title: const Text('Gọi Heli'),
              subtitle: const Text('Nói "Heli, ..." khi màn hình này đang mở'),
              value: s.handsFree,
              onChanged: _onHandsFree,
            ),
            if (s.micIssue)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(onPressed: _ctl.openSettings, icon: const Icon(Icons.settings_outlined), label: const Text('Mở Cài đặt để bật micro')),
                ),
              ),
            const Divider(height: 1),
            Expanded(
              child: s.messages.isEmpty
                  ? _Welcome(isAdmin: isAdmin, hints: hints, onHint: _send)
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.all(16),
                      itemCount: s.messages.length + (s.phase == HeliPhase.thinking ? 1 : 0),
                      itemBuilder: (_, i) => i < s.messages.length ? _Bubble(message: s.messages[i]) : const _Typing(),
                    ),
            ),
            if (s.heard.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                child: Text(s.heard, style: context.tt.bodyMedium?.copyWith(fontStyle: FontStyle.italic, color: context.co.muted)),
              ),
            _Composer(controller: _text, state: s, onSend: _send, onMic: _onMic),
          ]),
        ),
      ),
    );
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.state});
  final HeliState state;

  @override
  Widget build(BuildContext context) {
    final error = state.phase == HeliPhase.error;
    final color = error ? context.co.bad : (state.phase == HeliPhase.idle ? context.co.muted : context.cs.primary);
    return Semantics(
      liveRegion: true,
      label: 'Trạng thái Heli: ${state.statusText}',
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        color: error ? context.co.badTint : context.cs.surfaceContainerHighest,
        child: ExcludeSemantics(child: Text(state.statusText, style: context.tt.bodyMedium?.copyWith(color: color, fontWeight: FontWeight.w600))),
      ),
    );
  }
}

class _Welcome extends StatelessWidget {
  const _Welcome({required this.isAdmin, required this.hints, required this.onHint});
  final bool isAdmin;
  final List<String> hints;
  final void Function(String) onHint;

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(24), children: [
      Icon(Icons.graphic_eq_rounded, size: 48, color: context.cs.primary),
      const SizedBox(height: 12),
      Text('Xin chào, mình là Heli', textAlign: TextAlign.center, style: context.tt.titleLarge),
      const SizedBox(height: 8),
      Text(
        isAdmin ? 'Hỏi mình số liệu của quán: đơn hàng, doanh thu, món bán chạy, tồn kho…' : 'Bạn có thể trò chuyện với mình. Số liệu của quán chỉ dành cho quản trị viên.',
        textAlign: TextAlign.center,
        style: context.tt.bodyMedium?.copyWith(color: context.co.muted),
      ),
      const SizedBox(height: 16),
      Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
        for (final h in hints) ActionChip(label: Text(h), onPressed: () => onHint(h)),
      ]),
    ]);
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});
  final HeliMessage message;

  @override
  Widget build(BuildContext context) {
    final mine = message.fromUser;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Semantics(
        label: mine ? 'Bạn: ${message.text}' : 'Heli: ${message.text}',
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8 > 560 ? 560 : MediaQuery.sizeOf(context).width * 0.8),
          decoration: BoxDecoration(
            color: mine ? context.cs.primaryContainer : context.cs.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
          ),
          child: ExcludeSemantics(child: Text(message.text, style: context.tt.bodyLarge)), // plain text, never HTML
        ),
      ),
    );
  }
}

class _Typing extends StatelessWidget {
  const _Typing();

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: context.cs.primary)),
        ),
      );
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.state, required this.onSend, required this.onMic});
  final TextEditingController controller;
  final HeliState state;
  final VoidCallback onSend;
  final VoidCallback onMic;

  @override
  Widget build(BuildContext context) {
    final listening = state.phase == HeliPhase.listening;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 3,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => onSend(),
              decoration: InputDecoration(
                hintText: 'Hoặc gõ câu hỏi…',
                suffixIcon: IconButton(tooltip: 'Gửi', onPressed: state.phase == HeliPhase.thinking ? null : onSend, icon: const Icon(Icons.send_rounded)),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Semantics(
            button: true,
            label: listening ? 'Dừng nghe' : (state.phase == HeliPhase.speaking ? 'Ngắt Heli và nói' : 'Nhấn để nói với Heli'),
            child: ExcludeSemantics(
              child: GestureDetector(
                onTap: state.phase == HeliPhase.thinking ? null : onMic,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  width: listening ? 68 : 60,
                  height: listening ? 68 : 60,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: listening ? context.co.bad : context.cs.primary,
                    boxShadow: listening ? [BoxShadow(color: context.co.bad.withValues(alpha: 0.35), blurRadius: 16, spreadRadius: 4)] : null,
                  ),
                  child: Icon(listening ? Icons.stop_rounded : Icons.mic_rounded, color: Colors.white, size: 30),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}
