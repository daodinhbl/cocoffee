import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// What the manager needs from an operating-system process; the real one wraps dart:io, tests use a fake.
abstract class RunningProcess {
  Stream<String> get lines; // stdout + stderr, line by line
  Future<int> get exitCode;
  void kill();
}

abstract class ProcessLauncher {
  Future<RunningProcess> start(String exe, List<String> args, {Map<String, String>? env, String? workingDir});

  /// Runs a short command to completion.
  Future<({int code, String output})> run(String exe, List<String> args, {Map<String, String>? env, String? workingDir, Duration timeout = const Duration(minutes: 3)});
}

class _RealProcess implements RunningProcess {
  _RealProcess(this._p) {
    final merged = StreamController<String>.broadcast();
    var open = 2;
    void done() {
      if (--open == 0) merged.close();
    }

    for (final s in [_p.stdout, _p.stderr]) {
      s.transform(const Utf8Decoder(allowMalformed: true)).transform(const LineSplitter()).listen(merged.add, onDone: done, onError: (_) => done());
    }
    lines = merged.stream;
  }
  final Process _p;
  @override
  late final Stream<String> lines;
  @override
  Future<int> get exitCode => _p.exitCode;
  @override
  void kill() => _p.kill();
}

class RealLauncher implements ProcessLauncher {
  @override
  Future<RunningProcess> start(String exe, List<String> args, {Map<String, String>? env, String? workingDir}) async {
    final p = await Process.start(exe, args, environment: env, workingDirectory: workingDir, runInShell: false);
    return _RealProcess(p);
  }

  @override
  Future<({int code, String output})> run(String exe, List<String> args, {Map<String, String>? env, String? workingDir, Duration timeout = const Duration(minutes: 3)}) async {
    final r = await Process.run(exe, args, environment: env, workingDirectory: workingDir, stdoutEncoding: utf8, stderrEncoding: utf8).timeout(timeout);
    return (code: r.exitCode, output: '${r.stdout}${r.stderr}');
  }
}

enum ServiceState { stopped, starting, running, failed }

/// One child process the manager keeps alive (MariaDB, the web server, the ngrok agent): its state, its recent log, and an optional
/// restart policy. A restart is only tried while the manager wants the service running; [stop] never triggers one.
class ManagedService {
  ManagedService(this.name, {this.restartOnExit = false, this.maxRestarts = 5, this.restartWindow = const Duration(minutes: 2), this.onLine, DateTime Function()? now})
      : _now = now ?? DateTime.now;

  final String name;

  /// Start it again when it exits (the web server exits on purpose to apply a changed database connection).
  final bool restartOnExit;
  final int maxRestarts;
  final Duration restartWindow;
  final void Function(String line)? onLine;

  /// Extra listener on the raw lines (the tunnel looks for ngrok's error text).
  void Function(String line)? onLineHook;
  final DateTime Function() _now;

  final state = StreamController<ServiceState>.broadcast();
  ServiceState current = ServiceState.stopped;
  String? error;
  final List<String> log = [];
  RunningProcess? _proc;
  bool _wanted = false;
  final List<DateTime> _restarts = [];
  Future<RunningProcess> Function()? _starter;

  void _set(ServiceState s) {
    current = s;
    state.add(s);
  }

  void _addLine(String l) {
    log.add(l);
    if (log.length > 400) log.removeRange(0, log.length - 400);
    onLine?.call('[$name] $l');
    onLineHook?.call(l);
  }

  /// Starts the process made by [starter] and watches it.
  Future<void> start(Future<RunningProcess> Function() starter) async {
    _starter = starter;
    _wanted = true;
    error = null;
    _set(ServiceState.starting);
    try {
      _attach(await starter());
    } catch (e) {
      error = '$e';
      _set(ServiceState.failed);
      _wanted = false;
    }
  }

  void _attach(RunningProcess p) {
    _proc = p;
    p.lines.listen(_addLine, onError: (_) {});
    unawaited(p.exitCode.then((code) async {
      if (!identical(_proc, p)) return; // an older process, already replaced
      _proc = null;
      _addLine('đã thoát (mã $code)');
      if (!_wanted) {
        _set(ServiceState.stopped);
        return;
      }
      if (restartOnExit && _mayRestart()) {
        _addLine('khởi động lại…');
        _set(ServiceState.starting);
        try {
          _attach(await _starter!());
        } catch (e) {
          error = '$e';
          _wanted = false;
          _set(ServiceState.failed);
        }
        return;
      }
      error = 'Dừng bất thường (mã $code)';
      _wanted = false;
      _set(ServiceState.failed);
    }));
  }

  bool _mayRestart() {
    final t = _now();
    _restarts.removeWhere((x) => t.difference(x) > restartWindow);
    if (_restarts.length >= maxRestarts) return false; // crash loop: give up and show it
    _restarts.add(t);
    return true;
  }

  /// The caller decides when the service counts as up (a port answers, /health says ok).
  void markRunning() {
    if (current == ServiceState.starting) _set(ServiceState.running);
  }

  void markFailed(String why) {
    error = why;
    _set(ServiceState.failed);
  }

  Future<void> stop() async {
    _wanted = false;
    final p = _proc;
    _proc = null;
    if (p != null) {
      p.kill();
      await p.exitCode.timeout(const Duration(seconds: 10), onTimeout: () => -1);
    }
    _set(ServiceState.stopped);
  }

  bool get isActive => current == ServiceState.starting || current == ServiceState.running;
}
