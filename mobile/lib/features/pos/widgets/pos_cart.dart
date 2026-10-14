import 'package:flutter/material.dart' hide Thumb;

import '../../../core/format.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/common.dart';
import '../pos_models.dart';

/// Right pane of the web POS, 'Đơn hiện tại': order pill, table picker, Ghi chú / Giữ đơn / Hủy buttons, Zalo
/// banner, cart lines with steppers and per-line notes, totals and the 'THANH TOÁN' button.
class CartPanel extends StatelessWidget {
  const CartPanel({
    super.key,
    required this.data,
    required this.cart,
    required this.isAdmin,
    required this.phone,
    required this.draftCount,
    required this.onOpenTables,
    required this.onNote,
    required this.onHold,
    required this.onClear,
    required this.onOpenZalo,
    required this.onDiscount,
    required this.onPay,
    required this.onQty,
    required this.onRemove,
    required this.onLineNote,
  });

  final PosData data;
  final CartState cart;
  final bool isAdmin;
  final bool phone;
  final int draftCount;
  final VoidCallback onOpenTables;
  final VoidCallback onNote;
  final VoidCallback onHold;
  final VoidCallback onClear;
  final VoidCallback onOpenZalo;
  final VoidCallback onDiscount;
  final VoidCallback onPay;
  final void Function(int index, int delta) onQty;
  final ValueChanged<int> onRemove;
  final ValueChanged<int> onLineNote;

  @override
  Widget build(BuildContext context) {
    final busy = cart.busy;
    final empty = cart.isEmpty;
    final String thirdLabel;
    final IconData thirdIcon;
    if (cart.orderId == null) {
      thirdLabel = 'Xóa giỏ';
      thirdIcon = Icons.remove_shopping_cart_outlined;
    } else if (isAdmin) {
      thirdLabel = 'Hủy đơn';
      thirdIcon = Icons.cancel_outlined;
    } else {
      thirdLabel = 'Đóng đơn';
      thirdIcon = Icons.logout_rounded;
    }
    final thirdEnabled = !busy && (cart.orderId != null || !empty);

    return Material(
      color: context.cs.surface,
      child: Column(children: [
        SizedBox(height: 3, child: busy ? const LinearProgressIndicator() : null),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
            children: [
              Row(children: [
                Expanded(
                  child: Text('Đơn hiện tại',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.tt.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: Palette.navyDarker)),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(color: context.co.neutralTint, borderRadius: BorderRadius.circular(6)),
                    child: Text(
                      '${cart.orderCode ?? 'Đơn mới'}${cart.count > 0 ? ' · ${cart.count} món' : ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5, color: context.co.neutral, fontFeatures: tabular),
                    ),
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              _TablePicker(data: data, cart: cart, onTap: busy ? null : onOpenTables),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: _ActionButton(
                    icon: Icons.edit_note_rounded,
                    label: cart.note.isNotEmpty ? 'Có ghi chú' : 'Ghi chú',
                    highlighted: cart.note.isNotEmpty,
                    onTap: busy ? null : onNote,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _ActionButton(
                    icon: Icons.bookmark_border_rounded,
                    label: cart.orderId != null ? 'Lưu đơn' : 'Giữ đơn',
                    onTap: busy || empty ? null : onHold,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _ActionButton(
                    icon: thirdIcon,
                    label: thirdLabel,
                    danger: cart.orderId != null && isAdmin,
                    onTap: thirdEnabled ? onClear : null,
                  ),
                ),
              ]),
              if (draftCount > 0) ...[
                const SizedBox(height: 12),
                ZaloBanner(count: draftCount, onTap: onOpenZalo),
              ],
              const SizedBox(height: 12),
              if (empty)
                _EmptyCart(phone: phone)
              else
                for (final (i, l) in cart.lines.indexed) ...[
                  if (i > 0) const SizedBox(height: 8),
                  _CartLineTile(
                    line: l,
                    enabled: !busy,
                    onDec: () => onQty(i, -1),
                    onInc: () => onQty(i, 1),
                    onRemove: () => onRemove(i),
                    onNote: () => onLineNote(i),
                  ),
                ],
            ],
          ),
        ),
        _Totals(data: data, cart: cart, phone: phone, onDiscount: busy ? null : onDiscount, onPay: busy || empty ? null : onPay),
      ]),
    );
  }
}

class _TablePicker extends StatelessWidget {
  const _TablePicker({required this.data, required this.cart, required this.onTap});
  final PosData data;
  final CartState cart;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = data.table(cart.tableId);
    final Color fg;
    final Color bg;
    final String sub;
    if (t == null) {
      fg = context.co.warn;
      bg = context.co.warnTint;
      sub = cart.orderCode != null ? 'Đơn ${cart.orderCode}' : 'Khách mang đi · chạm để chọn bàn';
    } else if (t.busy || cart.orderId != null) {
      fg = context.co.bad;
      bg = context.co.badTint;
      sub = 'Đang phục vụ${cart.orderCode != null ? ' · ${cart.orderCode}' : ''}';
    } else {
      fg = context.co.good;
      bg = context.co.goodTint;
      sub = 'Bàn trống';
    }
    return Material(
      color: context.cs.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: context.co.line)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: SizedBox(
          height: 64,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)),
                child: Icon(t == null ? Icons.shopping_bag_outlined : Icons.table_restaurant_rounded, color: fg, size: 26),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(t?.label ?? 'Mang đi',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17, height: 1.25)),
                  Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: context.tt.bodySmall?.copyWith(height: 1.3)),
                ]),
              ),
              const SizedBox(width: 6),
              const Text('Đổi bàn', style: TextStyle(color: Palette.navyAccent, fontWeight: FontWeight.w600, fontSize: 14)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.icon, required this.label, required this.onTap, this.danger = false, this.highlighted = false});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool danger;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    final fg = !enabled
        ? context.co.muted
        : danger
            ? context.co.bad
            : highlighted
                ? Palette.navyAccent
                : context.cs.onSurface;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: Material(
        color: context.cs.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: highlighted && enabled ? Palette.navyAccent : context.co.line),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: SizedBox(
            height: 56,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(icon, size: 22, color: fg),
                const SizedBox(height: 2),
                Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5, color: fg, height: 1.2)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// '🔔 Có {n} đơn Zalo đang chờ xác nhận' — opens the Zalo inbox.
class ZaloBanner extends StatelessWidget {
  const ZaloBanner({super.key, required this.count, required this.onTap});
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Ink(
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [context.co.goodTint, context.co.warnTint]),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: context.co.good.withValues(alpha: 0.3)),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: context.co.good, shape: BoxShape.circle),
                child: const Icon(Icons.notifications_active_rounded, color: Colors.white, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Có $count đơn Zalo đang chờ xác nhận',
                      style: TextStyle(fontWeight: FontWeight.w700, color: context.co.good, height: 1.25)),
                  Text('Khách đang xác nhận qua Zalo — chạm để xem', style: context.tt.bodySmall?.copyWith(color: context.co.neutral)),
                ]),
              ),
              Icon(Icons.chevron_right_rounded, color: context.co.good),
            ]),
          ),
        ),
      ),
    );
  }
}

class _EmptyCart extends StatelessWidget {
  const _EmptyCart({required this.phone});
  final bool phone;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(children: [
        const Text('🧾', style: TextStyle(fontSize: 44)),
        const SizedBox(height: 8),
        Text('Chưa có món nào', style: context.tt.titleMedium?.copyWith(color: context.co.neutral)),
        const SizedBox(height: 2),
        Text(phone ? 'Chạm vào món ở tab Món để thêm vào đơn' : 'Chạm vào món bên trái để thêm vào đơn',
            textAlign: TextAlign.center, style: context.tt.bodyMedium?.copyWith(color: context.co.muted)),
      ]),
    );
  }
}

class _CartLineTile extends StatelessWidget {
  const _CartLineTile({required this.line, required this.enabled, required this.onDec, required this.onInc, required this.onRemove, required this.onNote});
  final CartLine line;
  final bool enabled;
  final VoidCallback onDec;
  final VoidCallback onInc;
  final VoidCallback onRemove;
  final VoidCallback onNote;

  @override
  Widget build(BuildContext context) {
    final hasNote = line.note.isNotEmpty;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
      decoration: BoxDecoration(border: Border.all(color: context.co.line), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          SizedBox(
            width: 36,
            child: line.imageUrl != null
                ? Thumb(url: line.imageUrl, name: line.name, size: 32)
                : Text(emojiOf(line.name), style: const TextStyle(fontSize: 24)),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(line.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, height: 1.25)),
              Text('${money(line.price)} / món', style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
            ]),
          ),
          IconButton(
            tooltip: 'Xóa ${line.name}',
            onPressed: enabled ? onRemove : null,
            icon: const Icon(Icons.delete_outline_rounded),
            color: context.co.muted,
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          ),
        ]),
        InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: enabled ? onNote : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
            child: Row(children: [
              Icon(hasNote ? Icons.sticky_note_2_outlined : Icons.add_comment_outlined, size: 16, color: Palette.navyAccent),
              const SizedBox(width: 6),
              Expanded(
                child: Text(hasNote ? line.note : 'Thêm ghi chú',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 13.5,
                        color: Palette.navyAccent,
                        fontStyle: hasNote ? FontStyle.italic : FontStyle.normal,
                        fontWeight: hasNote ? FontWeight.w600 : FontWeight.w500)),
              ),
            ]),
          ),
        ),
        Row(children: [
          Container(
            decoration: BoxDecoration(color: context.co.neutralTint, borderRadius: BorderRadius.circular(12)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(
                tooltip: 'Giảm ${line.name}',
                onPressed: enabled ? onDec : null,
                icon: const Icon(Icons.remove_rounded),
                color: Palette.navy,
                constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              ),
              SizedBox(
                width: 36,
                child: Text('${line.qty}',
                    textAlign: TextAlign.center, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700, fontFeatures: tabular)),
              ),
              IconButton(
                tooltip: 'Tăng ${line.name}',
                onPressed: enabled && line.qty < kMaxLineQty ? onInc : null,
                icon: const Icon(Icons.add_rounded),
                color: Palette.navy,
                constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              ),
            ]),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.only(right: 6),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(money(line.total),
                      style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: Palette.navyDarker, fontFeatures: tabular)),
                ),
              ),
            ),
          ),
        ]),
      ]),
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals({required this.data, required this.cart, required this.phone, required this.onDiscount, required this.onPay});
  final PosData data;
  final CartState cart;
  final bool phone;
  final VoidCallback? onDiscount;
  final VoidCallback? onPay;

  @override
  Widget build(BuildContext context) {
    final muted = context.tt.bodyMedium?.copyWith(color: context.co.neutral);
    final d = cart.discountApplied;
    return Container(
      decoration: BoxDecoration(color: context.cs.surface, border: Border(top: BorderSide(color: context.co.line))),
      padding: EdgeInsets.fromLTRB(16, 10, 16, 12 + MediaQuery.paddingOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Expanded(child: Text('Tạm tính', style: muted)),
          Text(money(cart.subtotal), style: const TextStyle(fontWeight: FontWeight.w600, fontFeatures: tabular)),
        ]),
        Row(children: [
          Expanded(child: Text('Giảm giá', style: muted)),
          SizedBox(
            height: 40,
            child: OutlinedButton(
              onPressed: onDiscount,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(56, 40),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                foregroundColor: Palette.navyAccent,
                side: BorderSide(color: context.cs.outline),
              ),
              child: Text(d > 0 ? '−${money(d)}' : '0đ', style: const TextStyle(fontFeatures: tabular)),
            ),
          ),
        ]),
        if (data.vatRate > 0)
          Row(children: [
            Expanded(child: Text('Trong đó VAT (${qty(data.vatRate)}%)', style: context.tt.bodySmall)),
            Text(money(cart.vat(data.vatRate)), style: context.tt.bodySmall?.copyWith(fontFeatures: tabular)),
          ]),
        const SizedBox(height: 6),
        const Divider(),
        const SizedBox(height: 6),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            flex: 2,
            child: Text('TỔNG THANH TOÁN', style: context.tt.labelLarge?.copyWith(color: context.co.neutral, letterSpacing: 0.6)),
          ),
          Expanded(
            flex: 3,
            child: Align(
              alignment: Alignment.centerRight,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(money(cart.total),
                    style: TextStyle(
                        fontSize: phone ? 32 : 40, fontWeight: FontWeight.w700, color: Palette.navyDarker, fontFeatures: tabular, height: 1.1)),
              ),
            ),
          ),
        ]),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          height: phone ? 60 : 72,
          child: FilledButton.icon(
            onPressed: onPay,
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              disabledBackgroundColor: context.co.neutralTint,
              textStyle: TextStyle(fontFamily: kSerif, fontSize: phone ? 20 : 23, fontWeight: FontWeight.w700, letterSpacing: 0.5),
            ),
            icon: const Icon(Icons.payments_outlined, size: 26),
            label: const Text('THANH TOÁN'),
          ),
        ),
      ]),
    );
  }
}
