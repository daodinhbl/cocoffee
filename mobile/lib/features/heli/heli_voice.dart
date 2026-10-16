import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../../core/session.dart';
import 'heli_state.dart';

/// Ears and mouth of Heli. The controller only talks to this interface, so tests replace it.
abstract class HeliVoice {
  /// Microphone permission as it is now (does not ask).
  Future<MicStatus> micStatus();

  /// Asks for the microphone permission (the system dialog).
  Future<MicStatus> requestMic();

  /// Opens the app's system settings (permission refused for good).
  Future<void> openSettings();

  /// Starts one recognition session. [onResult] gets the words so far and whether they are final; [onEnded] is
  /// called when the session stops by itself (silence, timeout, Android cutting it). false = no recognizer.
  Future<bool> listen({required void Function(String words, bool isFinal) onResult, required void Function() onEnded});

  Future<void> stopListening();

  /// Reads [text] aloud; completes when finished or stopped.
  Future<void> speak(String text);

  Future<void> stopSpeaking();

  /// The short "ting" after the name "Heli" was heard alone.
  Future<void> ting();

  Future<void> dispose();
}

/// POST /api/heli/tts -> mp3 bytes.
typedef HeliTtsFetch = Future<Uint8List> Function(String text);

final heliTtsFetchProvider = Provider<HeliTtsFetch>((ref) {
  return (text) async {
    final dio = Dio(BaseOptions(
      baseUrl: '${ref.read(serverUrlProvider)}/api',
      connectTimeout: const Duration(seconds: 8),
      receiveTimeout: const Duration(seconds: 25),
      responseType: ResponseType.bytes,
      headers: {'Authorization': 'Bearer ${ref.read(sessionStoreProvider).token ?? ''}'},
    ));
    final res = await dio.post<List<int>>('/heli/tts', data: {'text': text});
    final data = res.data;
    if (data == null || data.isEmpty) throw StateError('empty audio');
    return Uint8List.fromList(data);
  };
});

final heliVoiceProvider = Provider<HeliVoice>((ref) {
  final voice = DeviceHeliVoice(ref.read(heliTtsFetchProvider));
  ref.onDispose(voice.dispose);
  return voice;
});

/// speech_to_text (listening), the server's voice through just_audio (speaking), flutter_tts when the server's voice
/// cannot be fetched (offline, error).
class DeviceHeliVoice implements HeliVoice {
  DeviceHeliVoice(this._fetch);

  final HeliTtsFetch _fetch;
  final SpeechToText _stt = SpeechToText();
  AudioPlayer? _player;
  FlutterTts? _tts;
  bool _sttReady = false;
  String? _locale;
  void Function()? _onEnded;
  bool _stopSpeech = false;

  MicStatus _map(PermissionStatus s) =>
      s.isGranted ? MicStatus.granted : (s.isPermanentlyDenied || s.isRestricted ? MicStatus.permanentlyDenied : MicStatus.denied);

  @override
  Future<MicStatus> micStatus() async => _map(await Permission.microphone.status);

  @override
  Future<MicStatus> requestMic() async => _map(await Permission.microphone.request());

  @override
  Future<void> openSettings() async {
    await openAppSettings();
  }

  void _ended() {
    final f = _onEnded;
    _onEnded = null;
    f?.call();
  }

  Future<bool> _ready() async {
    if (_sttReady) return true;
    _sttReady = await _stt.initialize(
      onStatus: (s) {
        if (s == 'done' || s == 'notListening') _ended();
      },
      onError: (_) => _ended(),
    );
    if (_sttReady) {
      final locales = await _stt.locales();
      String norm(String id) => id.replaceAll('-', '_').toLowerCase();
      for (final l in locales) {
        if (norm(l.localeId) == 'vi_vn') _locale = l.localeId;
      }
      _locale ??= locales.where((l) => norm(l.localeId).startsWith('vi')).map((l) => l.localeId).firstOrNull ?? 'vi_VN';
    }
    return _sttReady;
  }

  @override
  Future<bool> listen({required void Function(String words, bool isFinal) onResult, required void Function() onEnded}) async {
    if (!await _ready()) return false;
    _onEnded = onEnded;
    await _stt.listen(
      onResult: (r) => onResult(r.recognizedWords, r.finalResult),
      listenOptions: SpeechListenOptions(
        partialResults: true,
        cancelOnError: false,
        listenMode: ListenMode.dictation,
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 3),
        localeId: _locale,
      ),
    );
    return true;
  }

  @override
  Future<void> stopListening() async {
    _onEnded = null;
    if (_sttReady) await _stt.cancel();
  }

  Future<File> _tempFile(String name, List<int> bytes) async {
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}${Platform.pathSeparator}$name');
    await f.writeAsBytes(bytes, flush: true);
    return f;
  }

  Future<void> _play(String name, List<int> bytes, AudioPlayer player) async {
    final file = await _tempFile(name, bytes);
    try {
      await player.setFilePath(file.path);
      await player.play(); // completes when the clip has played (or was stopped)
    } finally {
      try {
        await file.delete(); // no audio is kept on the phone
      } catch (_) {}
    }
  }

  @override
  Future<void> speak(String text) async {
    _stopSpeech = false;
    try {
      final bytes = await _fetch(text);
      if (_stopSpeech) return;
      await _play('heli_say.mp3', bytes, _player ??= AudioPlayer());
    } catch (_) {
      if (_stopSpeech) return;
      final tts = _tts ??= FlutterTts();
      await tts.setLanguage('vi-VN');
      await tts.awaitSpeakCompletion(true);
      await tts.speak(text);
    }
  }

  @override
  Future<void> stopSpeaking() async {
    _stopSpeech = true;
    await _player?.stop();
    await _tts?.stop();
  }

  @override
  Future<void> ting() async {
    final p = AudioPlayer();
    try {
      await _play('heli_ting.wav', _tingWav(), p);
    } catch (_) {
      // the sound is a courtesy
    } finally {
      await p.dispose();
    }
  }

  @override
  Future<void> dispose() async {
    _onEnded = null;
    try {
      if (_sttReady) await _stt.cancel();
    } catch (_) {}
    await _player?.dispose();
    await _tts?.stop();
  }
}

/// A 0.2 s sine "ting" (16-bit mono WAV), built in memory.
Uint8List _tingWav() {
  const rate = 22050;
  const n = rate ~/ 5;
  final data = ByteData(44 + n * 2);
  void tag(int at, String s) {
    for (var i = 0; i < s.length; i++) {
      data.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  data.setUint32(4, 36 + n * 2, Endian.little);
  tag(8, 'WAVEfmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, rate, Endian.little);
  data.setUint32(28, rate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  data.setUint32(40, n * 2, Endian.little);
  for (var i = 0; i < n; i++) {
    final decay = 1 - i / n;
    final v = math.sin(2 * math.pi * 1320 * i / rate) * decay * 0.5;
    data.setInt16(44 + i * 2, (v * 32767).round(), Endian.little);
  }
  return data.buffer.asUint8List();
}
