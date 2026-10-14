import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import 'report_models.dart';

/// Range the user picked (inclusive "YYYY-MM-DD" days). Null = let the server choose (its default is "7 ngày").
@immutable
class ReportRange {
  const ReportRange(this.from, this.to);
  final String from, to;

  @override
  bool operator ==(Object other) => other is ReportRange && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(from, to);
}

class ReportRangeNotifier extends Notifier<ReportRange?> {
  @override
  ReportRange? build() => null;

  /// Selects a range; reversed days are swapped like readRange() on the web. Returns false when nothing changed.
  bool select(String from, String to) {
    final next = from.compareTo(to) > 0 ? ReportRange(to, from) : ReportRange(from, to);
    if (next == state) return false;
    state = next;
    return true;
  }
}

final reportRangeProvider = NotifierProvider.autoDispose<ReportRangeNotifier, ReportRange?>(ReportRangeNotifier.new);

/// Retries only when the phone could not reach the server; validation or permission errors show at once.
Duration? _retry(int count, Object error) {
  final e = error is ApiException ? error : null;
  if (e == null || count >= 3) return null;
  return e.isOffline || e.code == 'TIMEOUT' ? Duration(seconds: 1 << count) : null;
}

/// GET /api/admin/reports?from=&to= -> every dataset of the Web Admin report page in one answer.
final reportProvider = FutureProvider.autoDispose<ReportData>((ref) async {
  final range = ref.watch(reportRangeProvider);
  final res = await ref.watch(apiProvider).get('/admin/reports', query: {'from': range?.from, 'to': range?.to});
  return ReportData.fromJson(res);
}, retry: _retry);
