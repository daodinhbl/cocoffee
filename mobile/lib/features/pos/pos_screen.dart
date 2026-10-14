import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../../core/offline/connectivity.dart';
import '../../core/offline/outbox.dart';
import '../../core/widgets/common.dart';
import '../../core/widgets/offline_banner.dart';
import 'pos_models.dart';
import 'pos_providers.dart';
import 'widgets/pos_cart.dart';
import 'widgets/pos_dialogs.dart';
import 'widgets/pos_pay_sheet.dart';
import 'widgets/pos_products.dart';
import 'widgets/pos_tables.dart';
import 'widgets/pos_zalo_inbox.dart';

/// Width (and height) from which the POS shows the tablet layout: main area + cart side panel.
const kPosWideWidth = 840.0;
const kPosWideHeight = 560.0;

/// How often the Zalo draft count is refreshed (shared hosting: polling, no push).
const kZaloPoll = Duration(seconds: 15);

/// NavigationBar height from the app theme (navigationBarTheme.height).
const _kNavBarHeight = 68.0;

enum PosView { tables, products, cart, zalo }

/// Bán hàng POS (views/pos.ejs + public/pos/pos.js, docs/UI-UX-SPEC.md Part 3). The cashier's whole app: it opens
/// without the admin shell, so the app bar carries the user, the admin shortcuts and the logout.
/// Phone: tabs Bàn | Món | Giỏ. Tablet (>= 840 dp): rail Bàn | Món | Zalo, the chosen area, and the cart panel.
class PosScreen extends ConsumerStatefulWidget {
  const PosScreen({super.key, this.tableId, this.orderId});
  final int? tableId;
  final int? orderId;

  @override
  ConsumerState<PosScreen> createState() => _PosScreenState();
}

class _PosScreenState extends ConsumerState<PosScreen> {
  PosView _view = PosView.products;
  final _search = TextEditingController();
  String _query = '';
  int? _category;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(kZaloPoll, (_) {
      if (!mounted) return;
      final life = WidgetsBinding.instance.lifecycleState;
      if (life != null && life != AppLifecycleState.resumed) return; // no polling in the background
      ref.invalidate(zaloDraftsProvider);
      setState(() {}); // header clock
    });
    if (widget.tableId != null || widget.orderId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _applyStart());
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    _search.dispose();
    super.dispose();
  }

  bool get _wide {
    final s = MediaQuery.sizeOf(context);
    return s.width >= kPosWideWidth && s.height >= kPosWideHeight;
  }

  void _go(PosView v) {
    if (!mounted) return;
    setState(() => _view = v);
  }

  double _cartWidth(double screenWidth) => (screenWidth * 0.35).clamp(340.0, 440.0);

  /// Toast like the web POS (ok 2.2 s, error 4 s), placed so it never covers the cart totals or 'THANH TOÁN':
  /// over the product area on tablets, at the top of the content on phones.
  void _toast(String message, {bool error = false}) {
    if (!mounted) return;
    final m = ScaffoldMessenger.maybeOf(context);
    if (m == null) return;
    final EdgeInsets margin;
    if (_wide) {
      margin = EdgeInsets.fromLTRB(93, 0, _cartWidth(MediaQuery.sizeOf(context).width) + 16, 16);
    } else {
      // Phones: at the top of the content, under the app bar, clear of the cart lines and the pay button.
      final mq = MediaQuery.of(context);
      final body = mq.size.height - mq.padding.top - kToolbarHeight - _kNavBarHeight - mq.padding.bottom;
      margin = EdgeInsets.fromLTRB(16, 0, 16, math.max(16.0, body - 84));
    }
    m.hideCurrentSnackBar();
    m.showSnackBar(SnackBar(
      content: Text(message),
      behavior: SnackBarBehavior.floating,
      margin: margin,
      backgroundColor: error ? context.co.bad : null,
      duration: Duration(milliseconds: error ? 4000 : 2200),
    ));
  }

  Future<void> _reload() async {
    if (!ref.read(netProvider).online) await ref.read(netProvider.notifier).probe();
    ref.invalidate(posBootstrapProvider);
    ref.invalidate(zaloDraftsProvider);
    try {
      await ref.read(posBootstrapProvider.future);
    } catch (_) {}
  }

  void _afterError(Object e) {
    if (!mounted) return;
    _toast(posError(e), error: true);
    if (isStale(e)) ref.invalidate(posBootstrapProvider);
  }

  /// /pos?order=12 opens that order; /pos?table=3 picks that table (opening its order when it is serving).
  Future<void> _applyStart() async {
    final PosData data;
    try {
      data = await ref.read(posBootstrapProvider.future);
    } catch (_) {
      return;
    }
    if (!mounted) return;
    final orderId = widget.orderId;
    if (orderId != null) {
      await _openOrder(orderId, data, null);
      return;
    }
    final t = data.table(widget.tableId);
    if (t != null) await _pickTable(t, data);
  }

  Future<void> _openOrder(int orderId, PosData data, PosTable? table) async {
    final notifier = ref.read(cartProvider.notifier);
    try {
      final o = await notifier.openOrder(orderId, data);
      if (!mounted) return;
      final where = table?.label ?? data.table(toIntOrNull(o['table_id']))?.label ?? 'Mang đi';
      _go(_wide ? PosView.products : PosView.cart);
      _toast('Đã mở đơn ${o['order_code'] ?? ''} của $where');
    } catch (e) {
      _afterError(e);
    }
  }

  /// Tap on the table map: takeaway (null), a free table (order for it) or a serving table (open its order).
  Future<void> _pickTable(PosTable? t, PosData data) async {
    final cart = ref.read(cartProvider);
    if (cart.busy) return;
    final unsaved = cart.dirty && cart.lines.isNotEmpty;
    if (t != null && t.heldLocally) {
      if (cart.localId == t.localHoldId) {
        _go(_wide ? PosView.products : PosView.cart);
        return;
      }
      final hold = ref.read(outboxProvider.notifier).byId(t.localHoldId!);
      if (hold == null) return;
      if (unsaved &&
          !await confirmPos(context,
              title: 'Bỏ giỏ hiện tại?',
              message: 'Giỏ hiện tại chưa được lưu. Mở đơn của ${t.label} sẽ thay thế các món trong giỏ.',
              action: 'Mở đơn')) {
        return;
      }
      ref.read(cartProvider.notifier).openLocal(hold, data);
      _go(_wide ? PosView.products : PosView.cart);
      _toast('Đã mở đơn ${hold.code} của ${t.label} (đang chờ đồng bộ).');
      return;
    }
    if (t != null && t.busy && t.currentOrderId != null) {
      if (cart.orderId == t.currentOrderId) {
        _go(_wide ? PosView.products : PosView.cart);
        return;
      }
      if (unsaved &&
          !await confirmPos(context,
              title: 'Bỏ giỏ hiện tại?',
              message: 'Giỏ hiện tại chưa được lưu. Mở đơn của ${t.label} sẽ thay thế các món trong giỏ.',
              action: 'Mở đơn')) {
        return;
      }
      await _openOrder(t.currentOrderId!, data, t);
      return;
    }
    if ((cart.orderId != null || cart.localId != null) && unsaved) {
      final ok = await confirmPos(context,
          title: 'Bỏ thay đổi chưa lưu?',
          message: 'Đơn ${cart.orderCode ?? ''} có thay đổi chưa lưu. Chọn ${t?.label ?? 'Mang đi'} sẽ đóng đơn này mà không lưu.',
          action: 'Đóng đơn');
      if (!ok) return;
    }
    ref.read(cartProvider.notifier).useTable(t?.id);
    _go(PosView.products);
  }

  Future<void> _editNote() async {
    final cart = ref.read(cartProvider);
    final v = await promptPos(context, title: 'Ghi chú cho đơn', initial: cart.note, hint: 'Ví dụ: khách ngồi ngoài sân');
    if (v != null) ref.read(cartProvider.notifier).setNote(v);
    if (v != null && cart.orderId != null && mounted) {
      _toast('Ghi chú đơn chỉ lưu khi tạo đơn mới; đơn đang mở giữ ghi chú cũ.');
    }
  }

  Future<void> _editDiscount() async {
    final cart = ref.read(cartProvider);
    final v = await promptPos(context, title: 'Giảm giá (đ)', initial: cart.discount > 0 ? '${cart.discount.round()}' : '', number: true, hint: '0');
    if (v != null) ref.read(cartProvider.notifier).setDiscount(num.tryParse(v) ?? 0);
  }

  Future<void> _editLineNote(int index) async {
    final lines = ref.read(cartProvider).lines;
    if (index >= lines.length) return;
    final v = await editLineNote(context, productName: lines[index].name, initial: lines[index].note);
    if (v != null) ref.read(cartProvider.notifier).setLineNote(index, v);
  }

  Future<void> _hold() async {
    final cart = ref.read(cartProvider);
    if (cart.busy || cart.isEmpty) return;
    if (cart.tableId == null && cart.orderId == null && cart.localId == null) {
      _go(PosView.tables);
      _toast('Chọn bàn để giữ đơn.', error: true);
      return;
    }
    try {
      final where = ref.read(posBootstrapProvider).value?.table(cart.tableId)?.label;
      final order = await ref.read(cartProvider.notifier).hold(where: where);
      if (!mounted) return;
      ref.invalidate(posBootstrapProvider);
      _go(PosView.tables);
      _toast(order['offline'] == true
          ? 'Đã lưu đơn ${order['order_code'] ?? ''} cho bàn · sẽ gửi lên máy chủ khi có mạng.'
          : 'Đã lưu đơn ${order['order_code'] ?? ''} cho bàn.');
    } catch (e) {
      _afterError(e);
    }
  }

  Future<void> _clear() async {
    final cart = ref.read(cartProvider);
    final notifier = ref.read(cartProvider.notifier);
    final isAdmin = ref.read(currentUserProvider)?.isAdmin ?? false;
    if (cart.busy) return;
    if (cart.orderId == null && cart.localId == null) {
      final ok = await confirmPos(context, title: 'Xóa giỏ hàng?', message: 'Bỏ tất cả món trong giỏ hiện tại.', action: 'Xóa giỏ', danger: true);
      if (ok) notifier.reset(keepTable: true);
      return;
    }
    final code = cart.orderCode ?? '';
    if (!isAdmin) {
      // Cancelling is admin-only (web rule): the cashier only closes the order, which stays on its table.
      if (cart.dirty &&
          !await confirmPos(context, title: 'Đóng đơn $code?', message: 'Các thay đổi chưa lưu sẽ bị bỏ. Đơn vẫn giữ trên bàn.', action: 'Đóng đơn')) {
        return;
      }
      notifier.reset();
      _go(PosView.tables);
      _toast('Đã đóng đơn $code. Đơn vẫn giữ trên bàn.');
      return;
    }
    final ok = await confirmPos(context,
        title: 'Hủy đơn $code?',
        message: cart.localId != null
            ? 'Đơn này chưa được gửi lên máy chủ; hủy sẽ bỏ hẳn đơn và trả bàn về trạng thái trống. Không thể hoàn tác.'
            : 'Đơn sẽ bị hủy và bàn được trả về trạng thái trống. Không thể hoàn tác.',
        action: 'Hủy đơn',
        danger: true);
    if (!ok) return;
    try {
      await notifier.cancelOpen();
      if (!mounted) return;
      ref.invalidate(posBootstrapProvider);
      _go(PosView.tables);
      _toast('Đã hủy đơn $code.');
    } catch (e) {
      _afterError(e);
    }
  }

  Future<void> _pay(PosData data) async {
    final cart = ref.read(cartProvider);
    if (cart.busy || cart.isEmpty) return;
    final notifier = ref.read(cartProvider.notifier);
    final where = data.table(cart.tableId)?.label ?? 'Mang đi';
    final out = await showPaySheet(
      context,
      subtitle: '$where · ${cart.count} món',
      subtotal: cart.subtotal,
      discount: cart.discount,
      onConfirm: (req) async {
        notifier.setDiscount(req.discount);
        try {
          return await notifier.checkout(req, where: where);
        } catch (e) {
          if (isStale(e)) ref.invalidate(posBootstrapProvider);
          rethrow;
        }
      },
    );
    if (out == null || !mounted) return;
    ref.invalidate(posBootstrapProvider);
    _go(out.tableId != null ? PosView.tables : PosView.products);
    final change = out.change > 0 ? ' Thối ${money(out.change)}.' : '';
    _toast(out.offline ? 'Đã lưu thanh toán ${out.code} · sẽ gửi lên máy chủ khi có mạng.$change' : 'Đã thanh toán ${out.code}.$change');
  }

  void _openZalo() {
    if (_wide) {
      _go(PosView.zalo);
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        // Own messenger: toasts of the inbox show inside the sheet instead of behind it.
        builder: (_, scroll) => ScaffoldMessenger(
          child: Scaffold(
            backgroundColor: Colors.transparent,
            body: ZaloInbox(scrollController: scroll, inSheet: true),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final boot = ref.watch(posBootstrapProvider);
    final cart = ref.watch(cartProvider);
    final user = ref.watch(currentUserProvider);
    final isAdmin = user?.isAdmin ?? false;
    final queued = ref.watch(outboxProvider.select((b) => b.items));
    final data = boot.value?.withLocalHolds(queued);
    final drafts = ref.watch(zaloDraftsProvider).value ?? data?.drafts ?? const <ZaloDraft>[];
    final wide = _wide;

    // A view that does not exist in this layout falls back to its neighbour (rotation, resize).
    var view = _view;
    if (wide && view == PosView.cart) view = PosView.products;
    if (!wide && view == PosView.zalo) view = PosView.cart;

    final appBar = _PosAppBar(
      user: user,
      zaloState: data?.zaloState ?? 'unknown',
      zaloLabel: data?.zaloLabel ?? '',
      draftCount: drafts.length,
      wide: MediaQuery.sizeOf(context).width >= kPosWideWidth,
      showClock: MediaQuery.sizeOf(context).width >= 1100,
      showZalo: !wide,
      onZalo: _openZalo,
      onReload: _reload,
      queuedCount: queued.length,
    );

    if (data == null) {
      return Scaffold(
        appBar: appBar,
        body: Column(children: [
          const OfflineBanner(),
          Expanded(child: AsyncBody<PosData>(value: boot, onRetry: _reload, data: (_) => const SizedBox.shrink())),
        ]),
      );
    }

    Widget products({Widget? footer}) => ProductPane(
          data: data,
          search: _search,
          query: _query,
          category: _category,
          onQuery: (q) => setState(() => _query = q),
          onCategory: (c) => setState(() => _category = c),
          qtyOf: cart.qtyOf,
          onAdd: ref.read(cartProvider.notifier).add,
          onRefresh: _reload,
          footer: footer,
        );

    final tables = TableMap(
      data: data,
      selectedTableId: cart.tableId,
      takeawaySelected: cart.tableId == null && cart.orderId == null,
      onPick: (t) => _pickTable(t, data),
      onRefresh: _reload,
    );

    final cartPanel = CartPanel(
      data: data,
      cart: cart,
      isAdmin: isAdmin,
      phone: !wide,
      draftCount: drafts.length,
      onOpenTables: () => _go(PosView.tables),
      onNote: _editNote,
      onHold: _hold,
      onClear: _clear,
      onOpenZalo: _openZalo,
      onDiscount: _editDiscount,
      onPay: () => _pay(data),
      onQty: ref.read(cartProvider.notifier).changeQty,
      onRemove: ref.read(cartProvider.notifier).removeAt,
      onLineNote: _editLineNote,
    );

    if (wide) {
      final width = MediaQuery.sizeOf(context).width;
      final cartWidth = _cartWidth(width);
      final railIndex = switch (view) { PosView.tables => 0, PosView.zalo => 2, _ => 1 };
      return Scaffold(
        appBar: appBar,
        body: Column(children: [
          const OfflineBanner(),
          Expanded(
            child: Row(children: [
          NavigationRail(
            selectedIndex: railIndex,
            labelType: NavigationRailLabelType.all,
            minWidth: 76,
            backgroundColor: context.cs.surface,
            indicatorColor: Palette.infoTint,
            selectedIconTheme: const IconThemeData(color: Palette.navy),
            selectedLabelTextStyle: const TextStyle(fontFamily: kSerif, color: Palette.navy, fontWeight: FontWeight.w700, fontSize: 13),
            unselectedLabelTextStyle: TextStyle(fontFamily: kSerif, color: context.co.neutral, fontSize: 13),
            onDestinationSelected: (i) => _go(const [PosView.tables, PosView.products, PosView.zalo][i]),
            destinations: [
              const NavigationRailDestination(icon: Icon(Icons.table_restaurant_outlined), selectedIcon: Icon(Icons.table_restaurant_rounded), label: Text('Bàn')),
              const NavigationRailDestination(icon: Icon(Icons.local_cafe_outlined), selectedIcon: Icon(Icons.local_cafe_rounded), label: Text('Món')),
              NavigationRailDestination(
                icon: Badge(isLabelVisible: drafts.isNotEmpty, label: Text('${drafts.length}'), child: const Icon(Icons.chat_outlined)),
                selectedIcon: Badge(isLabelVisible: drafts.isNotEmpty, label: Text('${drafts.length}'), child: const Icon(Icons.chat_rounded)),
                label: const Text('Zalo'),
              ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: switch (view) {
              PosView.tables => tables,
              PosView.zalo => ZaloInbox(onToast: _toast),
              _ => products(),
            },
          ),
          const VerticalDivider(width: 1),
          SizedBox(width: cartWidth, child: cartPanel),
        ]),
          ),
        ]),
      );
    }

    final tabIndex = switch (view) { PosView.tables => 0, PosView.products => 1, _ => 2 };
    return Scaffold(
      appBar: appBar,
      body: Column(children: [
        const OfflineBanner(),
        Expanded(
          child: switch (view) {
            PosView.tables => tables,
            PosView.products => products(
                footer: cart.isEmpty ? null : _CartSummaryBar(cart: cart, onOpen: () => _go(PosView.cart)),
              ),
            _ => cartPanel,
          },
        ),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tabIndex,
        onDestinationSelected: (i) => _go(const [PosView.tables, PosView.products, PosView.cart][i]),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.table_restaurant_rounded), label: 'Bàn'),
          const NavigationDestination(icon: Icon(Icons.local_cafe_rounded), label: 'Món'),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: cart.count > 0,
              backgroundColor: Palette.amber,
              textColor: Palette.ink900,
              label: Text('${cart.count}'),
              child: const Icon(Icons.shopping_cart_rounded),
            ),
            label: 'Giỏ',
          ),
        ],
      ),
    );
  }
}

/// Phone 'Món' tab: sticky summary of the cart with a shortcut to the 'Giỏ' tab.
class _CartSummaryBar extends StatelessWidget {
  const _CartSummaryBar({required this.cart, required this.onOpen});
  final CartState cart;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(color: context.cs.surface, border: Border(top: BorderSide(color: context.co.line))),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('${cart.count} món', style: context.tt.bodySmall),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(money(cart.total),
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: Palette.navyDarker, fontFeatures: tabular)),
            ),
          ]),
        ),
        const SizedBox(width: 12),
        FilledButton.icon(onPressed: onOpen, icon: const Icon(Icons.shopping_cart_checkout_rounded), label: const Text('Xem giỏ')),
      ]),
    );
  }
}

/// Header of the web POS: brand + Zalo status, admin shortcuts ('Quản lý', 'Đơn hàng'), the user and logout.
class _PosAppBar extends ConsumerWidget implements PreferredSizeWidget {
  const _PosAppBar({
    required this.user,
    required this.zaloState,
    required this.zaloLabel,
    required this.draftCount,
    required this.wide,
    required this.showClock,
    required this.showZalo,
    required this.onZalo,
    required this.onReload,
    this.queuedCount = 0,
  });

  final AppUser? user;
  final String zaloState;
  final String zaloLabel;
  final int draftCount;
  final bool wide;
  final bool showClock;
  final bool showZalo;
  final VoidCallback onZalo;
  final Future<void> Function() onReload;

  /// Writes waiting for the server (badge on the sync entry).
  final int queuedCount;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isAdmin = user?.isAdmin ?? false;
    final dot = switch (zaloState) { 'ok' => const Color(0xFF34D399), 'warn' => Palette.amber, _ => const Color(0xFF64748B) };
    final name = user?.fullName ?? '';
    const fg = Colors.white;

    void logout() => ref.read(authProvider.notifier).logout();

    final actions = <Widget>[
      if (isAdmin && wide) ...[
        TextButton.icon(
          onPressed: () => context.go('/dashboard'),
          style: TextButton.styleFrom(foregroundColor: Palette.navySoft),
          icon: const Icon(Icons.grid_view_rounded, size: 20),
          label: const Text('Quản lý'),
        ),
        TextButton.icon(
          onPressed: () => context.go('/orders'),
          style: TextButton.styleFrom(foregroundColor: Palette.navySoft),
          icon: const Icon(Icons.receipt_long_rounded, size: 20),
          label: const Text('Đơn hàng'),
        ),
      ],
      if (isAdmin && !wide)
        IconButton(tooltip: 'Đơn hàng', onPressed: () => context.go('/orders'), icon: const Icon(Icons.receipt_long_rounded)),
      if (showZalo)
        IconButton(
          tooltip: zaloLabel.isEmpty ? 'Đơn Zalo' : 'Đơn Zalo · $zaloLabel',
          onPressed: onZalo,
          icon: Badge(
            isLabelVisible: draftCount > 0,
            backgroundColor: Palette.amber,
            textColor: Palette.ink900,
            label: Text('$draftCount'),
            child: Stack(clipBehavior: Clip.none, children: [
              const Icon(Icons.chat_rounded),
              Positioned(
                left: -2,
                bottom: -2,
                child: Container(
                  width: 9,
                  height: 9,
                  decoration: BoxDecoration(color: dot, shape: BoxShape.circle, border: Border.all(color: Palette.navyDarker, width: 1.5)),
                ),
              ),
            ]),
          ),
        ),
      if (wide) ...[
        if (showClock) const _Clock(),
        const SizedBox(width: 6),
        Container(
          padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
          decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(12)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            _Avatar(name: name),
            const SizedBox(width: 8),
            Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, style: const TextStyle(color: fg, fontWeight: FontWeight.w600, fontSize: 14, height: 1.2)),
              Text(user?.roleLabel ?? '', style: const TextStyle(color: Palette.navyMuted, fontSize: 12, height: 1.2)),
            ]),
          ]),
        ),
        IconButton(tooltip: 'Tải lại dữ liệu', onPressed: onReload, icon: const Icon(Icons.refresh_rounded)),
        IconButton(
          tooltip: 'Đồng bộ ngoại tuyến',
          onPressed: () => openSyncScreen(context),
          icon: Badge(isLabelVisible: queuedCount > 0, backgroundColor: Palette.amber, textColor: Palette.ink900, label: Text('$queuedCount'), child: const Icon(Icons.cloud_sync_outlined)),
        ),
        // a cashier has no sidebar: Cài đặt (own password) is reached from here
        if (!isAdmin) IconButton(tooltip: 'Cài đặt', onPressed: () => context.push('/settings'), icon: const Icon(Icons.tune_rounded)),
        IconButton(tooltip: 'Đăng xuất', onPressed: logout, icon: const Icon(Icons.logout_rounded)),
        const SizedBox(width: 4),
      ] else
        PopupMenuButton<String>(
          tooltip: 'Tài khoản',
          icon: _Avatar(name: name),
          onSelected: (v) {
            switch (v) {
              case 'dashboard':
                context.go('/dashboard');
              case 'reload':
                onReload();
              case 'sync':
                openSyncScreen(context);
              case 'settings':
                context.push('/settings');
              case 'logout':
                logout();
            }
          },
          itemBuilder: (_) => [
            PopupMenuItem<String>(
              enabled: false,
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(name, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(user?.roleLabel ?? ''),
              ),
            ),
            if (isAdmin)
              const PopupMenuItem(value: 'dashboard', child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.grid_view_rounded), title: Text('Quản lý'))),
            const PopupMenuItem(value: 'reload', child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.refresh_rounded), title: Text('Tải lại dữ liệu'))),
            PopupMenuItem(
              value: 'sync',
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.cloud_sync_outlined),
                title: Text(queuedCount > 0 ? 'Đồng bộ ngoại tuyến ($queuedCount)' : 'Đồng bộ ngoại tuyến'),
              ),
            ),
            const PopupMenuItem(value: 'settings', child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.tune_rounded), title: Text('Cài đặt'))),
            const PopupMenuItem(value: 'logout', child: ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.logout_rounded), title: Text('Đăng xuất'))),
          ],
        ),
    ];

    return AppBar(
      backgroundColor: Palette.navyDarker,
      foregroundColor: fg,
      iconTheme: const IconThemeData(color: fg),
      actionsIconTheme: const IconThemeData(color: fg),
      titleSpacing: NavigationToolbar.kMiddleSpacing,
      title: Row(children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(color: const Color(0xFFFBF6EF), borderRadius: BorderRadius.circular(8)),
          child: const Icon(Icons.point_of_sale_rounded, color: Palette.navy, size: 22),
        ),
        const SizedBox(width: 10),
        Flexible(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            const Text('Bán hàng POS',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 17, height: 1.2)),
            if (wide)
              Row(mainAxisSize: MainAxisSize.min, children: [
                Container(width: 8, height: 8, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(zaloLabel,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Palette.navyMuted, fontSize: 12.5, height: 1.2)),
                ),
              ])
            else
              Text('$name · ${user?.roleLabel ?? ''}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Palette.navyMuted, fontSize: 12.5, height: 1.2)),
          ]),
        ),
      ]),
      actions: actions,
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: Palette.navy, borderRadius: BorderRadius.circular(9)),
      child: Text(userInitials(name), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
    );
  }
}

const _weekdays = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];

/// HH:mm and "Thứ Ba, 14/10" in shop time, like the web POS header (refreshed by the screen's 15 s timer).
class _Clock extends StatelessWidget {
  const _Clock();

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final shop = now.toUtc().add(const Duration(hours: 7));
    final day = shopDay(now).substring(0, 5);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(shopClock(now), style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w600, fontFeatures: tabular, height: 1.2)),
        Text('${_weekdays[shop.weekday - 1]}, $day', style: const TextStyle(color: Palette.navyMuted, fontSize: 12, height: 1.2)),
      ]),
    );
  }
}
