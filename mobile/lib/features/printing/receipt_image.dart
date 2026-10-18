import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';

import '../../core/format.dart';

/// What a receipt needs, from GET /api/orders/:id/receipt: { order, payments, printer, shop_name, vat }.
class ReceiptData {
  const ReceiptData({
    required this.shopName, required this.code, required this.time, required this.lines, required this.subtotal, required this.discount,
    required this.total, required this.payments, this.vat, this.address = '', this.phone = '', this.footer = '', this.table, this.note,
  });

  factory ReceiptData.fromJson(Map<String, dynamic> j) {
    final o = Map<String, dynamic>.from(j['order'] as Map? ?? const {});
    final p = Map<String, dynamic>.from(j['printer'] as Map? ?? const {});
    num n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
    return ReceiptData(
      shopName: '${j['shop_name'] ?? ''}',
      code: '${o['order_code'] ?? ''}',
      time: '${o['paid_at'] ?? o['completed_at'] ?? o['created_at'] ?? ''}',
      lines: [
        for (final i in (o['items'] as List? ?? const []))
          ReceiptLine('${(i as Map)['product_name'] ?? ''}', n(i['quantity']).toInt(), n(i['unit_price']), n(i['line_total']), i['note'] as String?),
      ],
      subtotal: n(o['subtotal']),
      discount: n(o['discount']),
      total: n(o['total']),
      payments: [
        for (final x in (j['payments'] as List? ?? const [])) '${_method((x as Map)['method'])}: ${money(x['amount'])}',
      ],
      vat: j['vat'] == null ? null : n(j['vat']),
      address: '${p['shopAddress'] ?? ''}',
      phone: '${p['shopPhone'] ?? ''}',
      footer: '${p['footer'] ?? ''}',
      table: o['table_name'] as String?,
      note: o['note'] as String?,
    );
  }

  final String shopName, code, time, address, phone, footer;
  final String? table, note;
  final List<ReceiptLine> lines;
  final num subtotal, discount, total;
  final num? vat;
  final List<String> payments;
}

class ReceiptLine {
  const ReceiptLine(this.name, this.qty, this.unitPrice, this.total, this.note);
  final String name;
  final int qty;
  final num unitPrice, total;
  final String? note;
}

String _method(Object? m) => switch ('$m') { 'cash' => 'Tiền mặt', 'transfer' => 'Chuyển khoản', 'card' => 'Thẻ', _ => 'Khác' };

/// Draws the receipt, [widthDots] wide (384 / 576), black on white, as an image ready for escposRaster.
/// Plain text only, in the system font, so Vietnamese accents always print.
Future<ui.Image> paintReceipt(ReceiptData d, int widthDots) async {
  final scale = widthDots / 384.0; // sizes below are for 384 dots
  final pad = 10.0 * scale;
  final contentW = widthDots - pad * 2;
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(ui.Rect.fromLTWH(0, 0, widthDots.toDouble(), 20000), ui.Paint()..color = const ui.Color(0xFFFFFFFF));

  var y = pad;
  TextPainter tp(String text, {double size = 20, bool bold = false, TextAlign align = TextAlign.left, double? width}) {
    return TextPainter(
      text: TextSpan(text: text, style: TextStyle(color: const ui.Color(0xFF000000), fontSize: size * scale, fontWeight: bold ? FontWeight.w700 : FontWeight.w400, height: 1.25)),
      textDirection: TextDirection.ltr,
      textAlign: align,
    )..layout(maxWidth: width ?? contentW, minWidth: width ?? 0);
  }

  void line(String text, {double size = 20, bool bold = false, TextAlign align = TextAlign.left}) {
    final p = tp(text, size: size, bold: bold, align: align, width: contentW);
    p.paint(canvas, ui.Offset(pad, y));
    y += p.height;
  }

  void pair(String left, String right, {bool bold = false, double size = 20}) {
    final r = tp(right, size: size, bold: bold, align: TextAlign.right, width: contentW * 0.4);
    final l = tp(left, size: size, bold: bold, width: contentW - r.width - 8 * scale);
    l.paint(canvas, ui.Offset(pad, y));
    r.paint(canvas, ui.Offset(pad + contentW - r.width, y));
    y += l.height > r.height ? l.height : r.height;
  }

  void rule() {
    y += 4 * scale;
    canvas.drawLine(ui.Offset(pad, y), ui.Offset(pad + contentW, y), ui.Paint()..color = const ui.Color(0xFF000000)..strokeWidth = 1.5 * scale);
    y += 6 * scale;
  }

  line(d.shopName.toUpperCase(), size: 26, bold: true, align: TextAlign.center);
  if (d.address.isNotEmpty) line(d.address, size: 18, align: TextAlign.center);
  if (d.phone.isNotEmpty) line('ĐT: ${d.phone}', size: 18, align: TextAlign.center);
  y += 6 * scale;
  line('HÓA ĐƠN', size: 24, bold: true, align: TextAlign.center);
  line(d.code, size: 20, align: TextAlign.center);
  final when = shopTime(d.time);
  line('$when${d.table == null || d.table!.isEmpty ? '' : ' · ${d.table}'}', size: 18, align: TextAlign.center);
  rule();
  for (final l in d.lines) {
    line(l.name, bold: true);
    pair('  ${l.qty} x ${vnd(l.unitPrice)}', vnd(l.total));
    if (l.note != null && l.note!.isNotEmpty) line('  (${l.note})', size: 17);
  }
  rule();
  if (d.discount > 0) {
    pair('Tạm tính', vnd(d.subtotal));
    pair('Giảm giá', '-${vnd(d.discount)}');
  }
  pair('TỔNG CỘNG', money(d.total), bold: true, size: 24);
  if (d.vat != null) pair('  (đã gồm VAT)', money(d.vat!.round()), size: 17);
  for (final p in d.payments) {
    line(p, size: 18);
  }
  if (d.note != null && d.note!.isNotEmpty) {
    y += 4 * scale;
    line('Ghi chú: ${d.note}', size: 17);
  }
  if (d.footer.isNotEmpty) {
    y += 8 * scale;
    line(d.footer, size: 18, align: TextAlign.center);
  }
  y += pad;

  final height = (y.ceil() + 7) & ~7; // whole rows of 8 dots
  final picture = recorder.endRecording();
  final image = await picture.toImage(widthDots, height);
  picture.dispose();
  return image;
}

/// RGBA bytes of [image] (for escposRaster).
Future<Uint8List> rgbaOf(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  return data!.buffer.asUint8List();
}
