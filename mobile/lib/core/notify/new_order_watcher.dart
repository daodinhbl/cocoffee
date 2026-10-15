import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../features/dashboard/dashboard_providers.dart';
import '../../features/orders/orders_providers.dart';
import '../format.dart';
import '../session.dart';

/// How often the app asks the server whether a customer confirmed a new Zalo order.
const kNewOrderPoll = Duration(seconds: 30);

const _kLastOrderId = 'new_order_last_id';
const _channel = AndroidNotificationDetails(
  'new_orders',
  'Đơn hàng mới',
  channelDescription: 'Báo khi khách xác nhận đơn qua Zalo',
  importance: Importance.high,
  priority: Priority.high,
);
const _iosDetails = DarwinNotificationDetails(presentAlert: true, presentSound: true, presentBadge: false);

/// One Zalo order the customer confirmed (GET /api/admin/new-orders).
class NewOrder {
  const NewOrder({required this.id, required this.code, required this.total, required this.itemCount, this.customer});

  factory NewOrder.fromJson(Map<String, dynamic> j) => NewOrder(
        id: (j['id'] as num).toInt(),
        code: '${j['order_code'] ?? ''}',
        total: (j['total'] as num?)?.toDouble() ?? 0,
        itemCount: (j['item_count'] as num?)?.toInt() ?? 0,
        customer: j['customer_name'] as String?,
      );

  final int id;
  final String code;
  final double total;
  final int itemCount;
  final String? customer;
}

/// Shows system notifications. Wrapped so tests (and platforms without the plugin) can swap it out.
class LocalNotifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  Future<void> init() async {
    if (_ready) return;
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          // The permission is asked below, once, instead of at start-up.
          iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        ),
      );
      await _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission(); // Android 13+: asks once
      await _plugin
          .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, sound: true); // iOS: asks once
      _ready = true;
    } catch (e) {
      if (kDebugMode) debugPrint('Notifications unavailable: $e');
    }
  }

  Future<void> show(int id, String title, String body) async {
    if (!_ready) return;
    try {
      await _plugin.show(id: id, title: title, body: body, notificationDetails: const NotificationDetails(android: _channel, iOS: _iosDetails));
    } catch (e) {
      if (kDebugMode) debugPrint('Notification not shown: $e');
    }
  }
}

final localNotifierProvider = Provider<LocalNotifier>((_) => LocalNotifier());

/// Latest order ids already announced, so a restart or a cached answer never repeats a notification.
Future<int?> _readLast() async {
  try {
    return (await SharedPreferences.getInstance()).getInt(_kLastOrderId);
  } catch (_) {
    return null;
  }
}

Future<void> _writeLast(int id) async {
  try {
    await (await SharedPreferences.getInstance()).setInt(_kLastOrderId, id);
  } catch (_) {/* best effort */}
}

/// Title and body of the notification for [orders] (one or several).
({String title, String body}) describeNewOrders(List<NewOrder> orders) {
  if (orders.length == 1) {
    final o = orders.first;
    final who = o.customer == null || o.customer!.isEmpty ? '' : '${o.customer} · ';
    return (title: 'Đơn mới ${o.code}', body: '$who${o.itemCount} món · ${money(o.total)}');
  }
  final total = orders.fold<double>(0, (s, o) => s + o.total);
  return (title: '${orders.length} đơn mới', body: 'Tổng ${money(total)} · ${orders.map((o) => o.code).join(', ')}');
}

/// While an admin is signed in, asks the server every [kNewOrderPoll] for Zalo orders confirmed since the last
/// one seen, shows a notification for them and refreshes the order lists. There is no push service (FCM): the
/// notification arrives while the app is open or recently in the background; the owner's Zalo message covers the rest.
/// The first run only remembers the current last order, so installing the app never announces old orders.
/// Off under `flutter test` (a periodic timer would outlive the widget tree); tests may override it.
final newOrderWatcherEnabledProvider = Provider<bool>((_) => !Platform.environment.containsKey('FLUTTER_TEST'));

final newOrderWatcherProvider = Provider<void>((ref) {
  if (!ref.watch(newOrderWatcherEnabledProvider)) return;
  final auth = ref.watch(authProvider);
  if (auth is! SignedIn || !auth.user.isAdmin || auth.user.mustChangePassword) return;

  final notifier = ref.read(localNotifierProvider);
  var busy = false;
  var disposed = false;

  Future<void> poll() async {
    if (busy || disposed) return;
    busy = true;
    try {
      final last = await _readLast();
      final res = await ref.read(apiProvider).get('/admin/new-orders', query: {'after_id': ?last}, useCache: false);
      final lastId = (res['last_id'] as num?)?.toInt() ?? 0;
      final orders = [for (final o in (res['orders'] as List? ?? const [])) NewOrder.fromJson(o as Map<String, dynamic>)];
      if (last == null || lastId > last) await _writeLast(lastId);
      if (orders.isEmpty || disposed) return;
      final text = describeNewOrders(orders);
      await notifier.show(orders.last.id, text.title, text.body);
      ref.invalidate(notificationsProvider);
      ref.invalidate(dashboardProvider);
      ref.invalidate(ordersPageProvider);
    } catch (_) {
      // offline / server busy: try again at the next tick
    } finally {
      busy = false;
    }
  }

  notifier.init().then((_) => poll());
  final timer = Timer.periodic(kNewOrderPoll, (_) => poll());
  ref.onDispose(() {
    disposed = true;
    timer.cancel();
  });
});
