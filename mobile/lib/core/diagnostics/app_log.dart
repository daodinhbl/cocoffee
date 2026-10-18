import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// A small on-device log of what went wrong (unhandled errors, refused replays), for the "Chẩn đoán" screen. Nothing is
/// sent anywhere: the owner copies or shares it when asking for help. Kept in memory (last [maxEntries]) and appended to
/// `app.log` in the app's private folder, which is trimmed when it grows past [maxFileBytes].
class LogEntry {
  const LogEntry(this.at, this.level, this.message);
  final DateTime at;
  final String level; // info | warn | error
  final String message;

  @override
  String toString() => '${at.toIso8601String()} [$level] $message';
}

class AppLog extends ChangeNotifier {
  AppLog._();
  static final AppLog instance = AppLog._();

  static const maxEntries = 200;
  static const maxFileBytes = 200 * 1024;

  final List<LogEntry> _entries = [];
  File? _file;

  List<LogEntry> get entries => List.unmodifiable(_entries.reversed);

  /// Hooks the Flutter / platform error handlers and loads the saved log. Safe to call without a folder (tests).
  Future<void> install(Directory? dir) async {
    if (dir != null) {
      _file = File('${dir.path}${Platform.pathSeparator}app.log');
      try {
        if (await _file!.exists()) {
          final lines = const LineSplitter().convert(utf8.decode(await _file!.readAsBytes(), allowMalformed: true));
          for (final l in lines.skip(lines.length > maxEntries ? lines.length - maxEntries : 0)) {
            final m = RegExp(r'^(\S+) \[(\w+)\] (.*)$').firstMatch(l);
            final at = m == null ? null : DateTime.tryParse(m.group(1)!);
            if (m != null && at != null) _entries.add(LogEntry(at, m.group(2)!, m.group(3)!));
          }
        }
      } catch (_) {/* a corrupt log is not worth a crash */}
    }
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      record('error', 'Flutter: ${details.exceptionAsString()}', details.stack);
      previous?.call(details);
    };
    PlatformDispatcher.instance.onError = (error, stack) {
      record('error', 'Chưa xử lý: $error', stack);
      return false;
    };
  }

  void record(String level, String message, [StackTrace? stack]) {
    final oneLine = message.replaceAll(RegExp(r'\s+'), ' ').trim();
    final text = stack == null ? oneLine : '$oneLine @ ${stack.toString().split('\n').take(3).join(' | ')}';
    final e = LogEntry(DateTime.now(), level, text.length > 600 ? '${text.substring(0, 600)}…' : text);
    _entries.add(e);
    if (_entries.length > maxEntries) _entries.removeAt(0);
    notifyListeners();
    // One write at a time: concurrent appends and the trim below would interleave and corrupt the file.
    _pending = _pending.then((_) => _append(e));
  }

  Future<void> _pending = Future.value();

  /// Completes when every line recorded so far is on disk (tests).
  @visibleForTesting
  Future<void> flush() => _pending;

  Future<void> _append(LogEntry e) async {
    final f = _file;
    if (f == null) return;
    try {
      await f.writeAsString('$e\n', mode: FileMode.append, flush: true);
      if (await f.length() > maxFileBytes) {
        final lines = const LineSplitter().convert(utf8.decode(await f.readAsBytes(), allowMalformed: true));
        await f.writeAsString('${lines.skip(lines.length ~/ 2).join('\n')}\n');
      }
    } catch (_) {/* logging must never fail the app */}
  }

  /// Stops writing to disk (the in-memory log stays). Used by tests that must not leave real file I/O pending.
  @visibleForTesting
  void detachFile() => _file = null;

  Future<void> clear() async {
    _entries.clear();
    notifyListeners();
    if (_file != null) await _pending;
    try {
      await _file?.writeAsString('');
    } catch (_) {/* nothing to clear */}
  }

  /// Everything as plain text, oldest first, for copying.
  String dump() => _entries.join('\n');
}
