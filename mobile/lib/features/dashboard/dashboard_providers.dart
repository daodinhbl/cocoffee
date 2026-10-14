import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import 'dashboard_models.dart';

/// No automatic retry: a 403 or a server error will not fix itself; the screen shows "Thử lại" and pull-to-refresh.
Duration? _noRetry(int _, Object _) => null;

/// GET /api/admin/dashboard (admin).
final dashboardProvider = FutureProvider.autoDispose<DashboardData>((ref) async {
  final res = await ref.watch(apiProvider).get('/admin/dashboard');
  return DashboardData.fromJson(res, fetchedAt: DateTime.now());
}, retry: _noRetry);

/// GET /api/admin/notifications (admin): the header bell.
final notificationsProvider = FutureProvider.autoDispose<NotificationsData>((ref) async {
  final res = await ref.watch(apiProvider).get('/admin/notifications');
  return NotificationsData.fromJson(res);
}, retry: _noRetry);

/// GET /api/zalo/status (staff): the header Zalo pill.
final zaloStatusProvider = FutureProvider.autoDispose<ZaloStatus>((ref) async {
  final res = await ref.watch(apiProvider).get('/zalo/status');
  return ZaloStatus.fromJson(res);
}, retry: _noRetry);
