import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session.dart';

/// While the server is unreachable, how often it is probed again (GET /health).
const kProbeInterval = Duration(seconds: 20);

/// Can the app reach its server right now? [online] flips to false when a request fails on the network (no
/// connection, timeout, 502-504) or when the device loses every network interface; it flips back when a request
/// succeeds or a probe answers. [since] is when the outage started.
class NetState {
  const NetState({required this.online, this.since, this.checking = false});

  final bool online;
  final DateTime? since;
  final bool checking;

  static const _keep = Object();

  NetState copyWith({bool? online, Object? since = _keep, bool? checking}) => NetState(
        online: online ?? this.online,
        since: identical(since, _keep) ? this.since : since as DateTime?,
        checking: checking ?? this.checking,
      );
}

/// "Is any network interface up" events. The device source wraps connectivity_plus; tests inject a stream.
typedef NetworkEvents = Stream<bool> Function();

final networkEventsProvider = Provider<NetworkEvents>((_) => () => Connectivity().onConnectivityChanged.map(hasNetwork));

bool hasNetwork(List<ConnectivityResult> results) => results.isNotEmpty && !results.every((r) => r == ConnectivityResult.none);

final netProvider = NotifierProvider<NetNotifier, NetState>(NetNotifier.new);

class NetNotifier extends Notifier<NetState> {
  Timer? _timer;
  StreamSubscription<bool>? _sub;
  Future<bool>? _probing;

  @override
  NetState build() {
    _sub = ref.read(networkEventsProvider)().listen((up) => up ? probe() : markOffline(), onError: (Object _) {});
    ref.onDispose(() {
      _sub?.cancel();
      _timer?.cancel();
    });
    return const NetState(online: true);
  }

  /// A request just failed on the network: offline until a request or a probe gets through.
  void markOffline() {
    if (state.online) state = NetState(online: false, since: DateTime.now());
    _schedule();
  }

  /// A request just got through.
  void markOnline() {
    _timer?.cancel();
    _timer = null;
    if (!state.online) state = const NetState(online: true);
  }

  /// GET /health with a short timeout, then updates the state. One probe at a time.
  Future<bool> probe() => _probing ??= _doProbe().whenComplete(() => _probing = null);

  Future<bool> _doProbe() async {
    state = state.copyWith(checking: true);
    var ok = false;
    try {
      ok = await ref.read(apiProvider).ping();
    } catch (_) {
      ok = false;
    }
    if (!ref.mounted) return ok;
    if (ok) {
      markOnline();
    } else {
      markOffline();
    }
    state = state.copyWith(checking: false);
    return ok;
  }

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(kProbeInterval, () {
      _timer = null;
      probe();
    });
  }
}
