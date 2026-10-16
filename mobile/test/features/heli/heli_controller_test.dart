import 'dart:async';

import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/heli/heli_controller.dart';
import 'package:cocoffee_mobile/features/heli/heli_state.dart';
import 'package:cocoffee_mobile/features/heli/heli_voice.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../helpers/test_app.dart';

class FakeVoice implements HeliVoice {
  MicStatus mic = MicStatus.granted;
  bool recognizer = true;
  void Function(String, bool)? onResult;
  void Function()? onEnded;
  int listens = 0, tings = 0;
  final spoken = <String>[];
  bool listening = false;

  @override
  Future<MicStatus> micStatus() async => mic;
  @override
  Future<MicStatus> requestMic() async => mic;
  @override
  Future<void> openSettings() async {}
  @override
  Future<bool> listen({required void Function(String words, bool isFinal) onResult, required void Function() onEnded}) async {
    if (!recognizer) return false;
    listens++;
    listening = true;
    this.onResult = onResult;
    this.onEnded = onEnded;
    return true;
  }

  @override
  Future<void> stopListening() async {
    listening = false;
    onResult = null;
    onEnded = null;
  }

  @override
  Future<void> speak(String text) async => spoken.add(text);
  @override
  Future<void> stopSpeaking() async {}
  @override
  Future<void> ting() async => tings++;
  @override
  Future<void> dispose() async {}

  void say(String words) => onResult?.call(words, true);
}

Future<ProviderContainer> _container(MockApi api, FakeVoice voice, {AppUser user = adminUser, DateTime Function()? clock}) async {
  SharedPreferences.setMockInitialValues({});
  final session = SessionStore(await SharedPreferences.getInstance());
  final c = ProviderContainer(overrides: [
    sessionStoreProvider.overrideWithValue(session),
    apiProvider.overrideWithValue(api),
    currentUserProvider.overrideWithValue(user),
    networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
    heliVoiceProvider.overrideWithValue(voice),
    heliRestartDelayProvider.overrideWithValue(Duration.zero),
    if (clock != null) heliClockProvider.overrideWithValue(clock),
  ]);
  addTearDown(c.dispose);
  c.listen(heliProvider, (_, _) {}); // keep it alive
  return c;
}

void main() {
  late MockApi api;
  late FakeVoice voice;

  setUp(() {
    api = MockApi();
    voice = FakeVoice();
    when(() => api.post('/heli/chat', any())).thenAnswer((i) async => {'reply': 'Hôm nay có 12 đơn.'});
    when(() => api.post('/heli/reset')).thenAnswer((_) async => {'ok': true});
  });

  List<String> asked() => verify(() => api.post('/heli/chat', captureAny())).captured.map((b) => (b as Map)['message'] as String).toList();

  test('mic button: listen -> thinking -> speaking -> idle, answer shown and read aloud', () async {
    final c = await _container(api, voice);
    final ctl = c.read(heliProvider.notifier);
    await ctl.tapMic();
    expect(c.read(heliProvider).phase, HeliPhase.listening);
    voice.onResult!('hôm nay', false);
    expect(c.read(heliProvider).heard, 'hôm nay');
    voice.say('hôm nay bao nhiêu đơn');
    await pumpEventQueue();
    final s = c.read(heliProvider);
    expect(s.phase, HeliPhase.idle);
    expect(s.messages.map((m) => (m.fromUser, m.text)), [(true, 'hôm nay bao nhiêu đơn'), (false, 'Hôm nay có 12 đơn.')]);
    expect(voice.spoken, ['Hôm nay có 12 đơn.']);
    expect(asked(), ['hôm nay bao nhiêu đơn']);
  });

  test('tapping the mic while listening stops without sending', () async {
    final c = await _container(api, voice);
    final ctl = c.read(heliProvider.notifier);
    await ctl.tapMic();
    await ctl.tapMic();
    expect(c.read(heliProvider).phase, HeliPhase.idle);
    verifyNever(() => api.post('/heli/chat', any()));
  });

  group('hands-free', () {
    test('speech without the name is dropped and never sent to the server', () async {
      final c = await _container(api, voice);
      final ctl = c.read(heliProvider.notifier);
      await ctl.setHandsFree(true);
      expect(c.read(heliProvider).statusText, 'Đang chờ gọi Heli…');
      voice.say('cho tôi hai ly cà phê sữa');
      await pumpEventQueue();
      verifyNever(() => api.post('/heli/chat', any()));
      expect(c.read(heliProvider).phase, HeliPhase.listening, reason: 'keeps waiting');
      expect(voice.listens, 2, reason: 'listening restarted');
    });

    test('"Heli, ..." sends only the question', () async {
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).setHandsFree(true);
      voice.say('Heli, hôm nay bao nhiêu đơn?');
      await pumpEventQueue();
      expect(asked(), ['hôm nay bao nhiêu đơn?']);
      expect(voice.spoken, isNotEmpty);
      expect(c.read(heliProvider).phase, HeliPhase.listening, reason: 'back to waiting after the answer');
    });

    test('only "Heli": ting, then the next phrase is the command', () async {
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).setHandsFree(true);
      voice.say('Heli');
      await pumpEventQueue();
      expect(voice.tings, 1);
      verifyNever(() => api.post('/heli/chat', any()));
      voice.say('doanh thu hôm nay');
      await pumpEventQueue();
      expect(asked(), ['doanh thu hôm nay']);
    });

    test('follow-up within 20 s needs no name; after 20 s it does', () async {
      var now = DateTime(2026, 10, 16, 9);
      final c = await _container(api, voice, clock: () => now);
      await c.read(heliProvider.notifier).setHandsFree(true);
      voice.say('Heli hôm nay bao nhiêu đơn');
      await pumpEventQueue();
      now = now.add(const Duration(seconds: 15));
      voice.say('còn hôm qua thì sao');
      await pumpEventQueue();
      expect(asked(), ['hôm nay bao nhiêu đơn', 'còn hôm qua thì sao']);
      clearInteractions(api);
      now = now.add(const Duration(seconds: 25));
      voice.say('còn hôm kia thì sao');
      await pumpEventQueue();
      verifyNever(() => api.post('/heli/chat', any()));
    });

    test('pause() (screen closed / app in background) switches it off and stops listening', () async {
      final c = await _container(api, voice);
      final ctl = c.read(heliProvider.notifier);
      await ctl.setHandsFree(true);
      await ctl.pause();
      expect(c.read(heliProvider).handsFree, isFalse);
      expect(voice.listening, isFalse);
    });
  });

  group('errors', () {
    test('offline: no request, "Heli cần kết nối mạng."', () async {
      final c = await _container(api, voice);
      c.read(netProvider.notifier).markOffline();
      await c.read(heliProvider.notifier).submit('xin chào');
      final s = c.read(heliProvider);
      expect(s.error, 'Heli cần kết nối mạng.');
      expect(s.messages, isEmpty);
      verifyNever(() => api.post('/heli/chat', any()));
    });

    test('429 -> "Bạn thao tác quá nhanh"', () async {
      when(() => api.post('/heli/chat', any())).thenThrow(ApiException(code: 'RATE_LIMITED', status: 429, message: 'x'));
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).submit('alo');
      expect(c.read(heliProvider).phase, HeliPhase.error);
      expect(c.read(heliProvider).error, startsWith('Bạn thao tác quá nhanh'));
    });

    test('401: the Vietnamese session message, the app signs out through the core client', () async {
      when(() => api.post('/heli/chat', any())).thenThrow(ApiException(code: 'UNAUTHORIZED', status: 401, message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).submit('alo');
      expect(c.read(heliProvider).error, contains('hết hạn'));
    });

    test('server error text is shown as is (already Vietnamese), no technical detail', () async {
      when(() => api.post('/heli/chat', any())).thenThrow(ApiException(code: 'HELI_UPSTREAM', status: 502, message: 'Heli tạm thời không phản hồi'));
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).submit('alo');
      expect(c.read(heliProvider).error, 'Heli tạm thời không phản hồi');
    });

    test('microphone refused for good: hands-free stays off and the settings button is offered', () async {
      voice.mic = MicStatus.permanentlyDenied;
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).setHandsFree(true);
      final s = c.read(heliProvider);
      expect(s.handsFree, isFalse);
      expect(s.micIssue, isTrue);
      expect(voice.listens, 0);
    });

    test('no recognizer on the phone: says so, typing still works', () async {
      voice.recognizer = false;
      final c = await _container(api, voice);
      await c.read(heliProvider.notifier).tapMic();
      expect(c.read(heliProvider).error, contains('gõ chữ'));
      await c.read(heliProvider.notifier).submit('xin chào');
      expect(c.read(heliProvider).messages, hasLength(2));
    });
  });

  test('cashier chats normally; the server (not the app) refuses data and the refusal is just shown', () async {
    when(() => api.post('/heli/chat', any())).thenAnswer((_) async => {'reply': 'Chỉ quản trị viên xem được số liệu nhé.'});
    final c = await _container(api, voice, user: cashierUser);
    await c.read(heliProvider.notifier).submit('doanh thu hôm nay?');
    expect(c.read(heliProvider).messages.last.text, 'Chỉ quản trị viên xem được số liệu nhé.');
  });

  test('a 403 from the server is shown in Vietnamese', () async {
    when(() => api.post('/heli/chat', any())).thenThrow(ApiException(code: 'FORBIDDEN', status: 403, message: 'Tài khoản của bạn không có quyền làm việc này.'));
    final c = await _container(api, voice, user: cashierUser);
    await c.read(heliProvider.notifier).submit('alo');
    expect(c.read(heliProvider).error, contains('không có quyền'));
  });

  test('new conversation clears the screen and resets the server', () async {
    final c = await _container(api, voice);
    final ctl = c.read(heliProvider.notifier);
    await ctl.submit('xin chào');
    expect(c.read(heliProvider).messages, isNotEmpty);
    await ctl.newConversation();
    expect(c.read(heliProvider).messages, isEmpty);
    verify(() => api.post('/heli/reset')).called(1);
  });

  test('a late answer to a conversation that was reset is dropped', () async {
    final slow = Completer<Map<String, dynamic>>();
    when(() => api.post('/heli/chat', any())).thenAnswer((_) => slow.future);
    final c = await _container(api, voice);
    final ctl = c.read(heliProvider.notifier);
    unawaited(ctl.submit('câu cũ'));
    await pumpEventQueue();
    expect(c.read(heliProvider).phase, HeliPhase.thinking);
    await ctl.newConversation();
    slow.complete({'reply': 'trả lời muộn'});
    await pumpEventQueue();
    expect(c.read(heliProvider).messages, isEmpty);
  });
}
