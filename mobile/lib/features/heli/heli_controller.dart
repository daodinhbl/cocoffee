import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/offline/connectivity.dart';
import '../../core/session.dart';
import 'heli_state.dart';
import 'heli_voice.dart';
import 'heli_wake.dart';

final heliClockProvider = Provider<DateTime Function()>((_) => DateTime.now);

/// Pause before listening again after a session ended by itself (Android ends them on every silence).
final heliRestartDelayProvider = Provider<Duration>((_) => const Duration(milliseconds: 300));

final heliProvider = NotifierProvider<HeliController, HeliState>(HeliController.new);

/// Heli's conversation and ears. Nothing runs in the background: the screen calls [pause] when it closes or the
/// app goes to the background, and a sign-out rebuilds this notifier (so it stops and forgets the conversation).
class HeliController extends Notifier<HeliState> {
  late HeliVoice _voice;
  int _session = 0; // bumped whenever listening starts/stops or a question is sent; older callbacks are ignored
  int _epoch = 0; // bumped by "Cuộc trò chuyện mới"; a late answer to an older conversation is dropped
  bool _push = false; // the current listening session came from the mic button: no "Heli" needed

  DateTime _now() => ref.read(heliClockProvider)();

  @override
  HeliState build() {
    ref.watch(currentUserProvider.select((u) => u?.id));
    _voice = ref.watch(heliVoiceProvider);
    ref.onDispose(() {
      _session++;
      _voice.stopListening();
      _voice.stopSpeaking();
    });
    return const HeliState();
  }

  Future<MicStatus> micStatus() => _voice.micStatus();

  Future<void> openSettings() => _voice.openSettings();

  void _fail(String message) {
    state = state.copyWith(phase: HeliPhase.error, error: message, errorSeq: state.errorSeq + 1, heard: '');
  }

  Future<bool> _ensureMic() async {
    var s = await _voice.micStatus();
    if (s != MicStatus.granted) s = await _voice.requestMic();
    if (!ref.mounted) return false;
    if (s == MicStatus.granted) {
      if (state.micIssue) state = state.copyWith(micIssue: false);
      return true;
    }
    state = state.copyWith(handsFree: false, micIssue: s == MicStatus.permanentlyDenied);
    _fail('Heli cần quyền micro để nghe bạn nói.');
    return false;
  }

  /// The round mic button: starts listening for one question; while listening or speaking it stops.
  Future<void> tapMic() async {
    if (state.phase == HeliPhase.thinking) return;
    if (state.phase == HeliPhase.listening && !state.handsFree) {
      _session++;
      await _voice.stopListening();
      state = state.copyWith(phase: HeliPhase.idle, heard: '');
      return;
    }
    if (state.phase == HeliPhase.speaking) await _voice.stopSpeaking();
    await _listen(push: true);
  }

  Future<void> setHandsFree(bool on) async {
    if (!on) {
      _session++;
      await _voice.stopListening();
      state = state.copyWith(handsFree: false, followUpUntil: null, heard: '', phase: state.phase == HeliPhase.listening ? HeliPhase.idle : state.phase);
      return;
    }
    if (!await _ensureMic()) return;
    state = state.copyWith(handsFree: true);
    if (!state.busy) await _listen(push: false);
  }

  Future<void> _listen({required bool push}) async {
    if (!await _ensureMic()) return;
    final id = ++_session;
    _push = push;
    state = state.copyWith(phase: HeliPhase.listening, heard: '', error: null);
    final ok = await _voice.listen(onResult: (w, fin) => _onHeard(id, w, fin), onEnded: () => _onEnded(id));
    if (!ref.mounted || id != _session) return;
    if (!ok) {
      state = state.copyWith(handsFree: false);
      _fail('Máy chưa có nhận dạng giọng nói. Bạn có thể gõ chữ để hỏi Heli.');
    }
  }

  void _onHeard(int id, String words, bool isFinal) {
    if (!ref.mounted || id != _session || state.phase != HeliPhase.listening) return;
    if (!isFinal) {
      state = state.copyWith(heard: words);
      return;
    }
    _session++; // this listening session is used up
    final text = words.trim();
    if (_push) {
      if (text.isEmpty) {
        _afterSilence();
      } else {
        unawaited(submit(text));
      }
      return;
    }
    switch (decideWake(text, now: _now(), activeUntil: state.followUpUntil)) {
      case WakeIgnore():
        _afterSilence(); // not for Heli: nothing is sent to the server
      case WakeCalled():
        unawaited(_ting());
      case WakeCommand(:final text):
        unawaited(submit(text));
    }
  }

  void _onEnded(int id) {
    if (!ref.mounted || id != _session || state.phase != HeliPhase.listening) return;
    _session++;
    _afterSilence();
  }

  Future<void> _ting() async {
    state = state.copyWith(heard: '', followUpUntil: _now().add(kHeliFollowUp));
    await _voice.ting();
    if (ref.mounted && state.handsFree) await _listen(push: false);
  }

  void _afterSilence() {
    if (!state.handsFree) {
      state = state.copyWith(phase: HeliPhase.idle, heard: '');
      return;
    }
    unawaited(_restart());
  }

  Future<void> _restart() async {
    final id = _session;
    await Future<void>.delayed(ref.read(heliRestartDelayProvider));
    if (ref.mounted && id == _session && state.handsFree && !state.busy) await _listen(push: false);
  }

  /// Asks Heli. Used by the text box and by voice.
  Future<void> submit(String raw) async {
    final text = raw.trim();
    if (text.isEmpty || state.phase == HeliPhase.thinking) return;
    final mine = ++_session;
    final epoch = _epoch;
    await _voice.stopListening();
    await _voice.stopSpeaking();
    if (!ref.mounted || mine != _session) return;

    if (!ref.read(netProvider).online) {
      _fail('Heli cần kết nối mạng.');
      if (state.handsFree) _afterSilence();
      return;
    }
    state = state.copyWith(
      messages: [...state.messages, HeliMessage(fromUser: true, text: text)],
      phase: HeliPhase.thinking,
      heard: '',
      error: null,
    );
    String reply;
    try {
      final res = await ref.read(apiProvider).post('/heli/chat', {'message': text});
      reply = '${res['reply'] ?? ''}'.trim();
      if (reply.isEmpty) reply = 'Mình chưa có câu trả lời, bạn hỏi lại giúp mình nhé.';
    } catch (e) {
      if (!ref.mounted || epoch != _epoch) return;
      _fail(_errorText(toApiException(e)));
      if (mine == _session && state.handsFree) _afterSilence();
      return;
    }
    if (!ref.mounted || epoch != _epoch) return;
    state = state.copyWith(messages: [...state.messages, HeliMessage(fromUser: false, text: reply)]);
    if (mine != _session) return; // paused, or the user took over meanwhile: show the answer, do not read it
    state = state.copyWith(phase: HeliPhase.speaking);
    try {
      await _voice.speak(reply);
    } catch (_) {
      // reading aloud is a courtesy; the answer is on the screen
    }
    if (!ref.mounted || mine != _session) return;
    state = state.copyWith(phase: HeliPhase.idle, followUpUntil: state.handsFree ? _now().add(kHeliFollowUp) : null);
    if (state.handsFree) await _listen(push: false);
  }

  String _errorText(ApiException e) {
    if (e.status == 429 || e.code == 'RATE_LIMITED') return 'Bạn thao tác quá nhanh, hãy đợi một chút rồi hỏi lại.';
    if (e.isOffline) return 'Heli cần kết nối mạng.';
    return e.message;
  }

  /// Screen closed, app in the background, or sign-out: stop hearing and speaking, switch hands-free off.
  Future<void> pause() async {
    _session++;
    await _voice.stopListening();
    await _voice.stopSpeaking();
    if (!ref.mounted) return;
    state = state.copyWith(
      handsFree: false,
      followUpUntil: null,
      heard: '',
      phase: state.phase == HeliPhase.thinking ? HeliPhase.thinking : HeliPhase.idle,
    );
  }

  /// "Cuộc trò chuyện mới": forgets the messages here and on the server.
  Future<void> newConversation() async {
    _epoch++;
    _session++;
    await _voice.stopListening();
    await _voice.stopSpeaking();
    if (!ref.mounted) return;
    final hands = state.handsFree;
    state = HeliState(handsFree: hands);
    try {
      await ref.read(apiProvider).post('/heli/reset');
    } catch (_) {
      // offline: the server keeps its short history until the next reset; the screen is cleared anyway
    }
    if (ref.mounted && hands) await _listen(push: false);
  }
}
