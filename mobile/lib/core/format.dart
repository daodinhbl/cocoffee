/// Formatting identical to the Web Admin (src/utils/text.js, src/utils/viewHelpers.js):
/// money "25.000đ", quantities "1.234,5" (trailing zeros dropped), shop time dd/MM/yyyy HH:mm at UTC+7.
library;

String _group(String digits) {
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write('.');
    out.write(digits[i]);
  }
  return out.toString();
}

num _toNum(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

/// 1250000 -> "1.250.000"
String vnd(Object? value) {
  final n = _toNum(value).round();
  final s = _group(n.abs().toString());
  return n < 0 ? '−$s' : s;
}

/// 1250000 -> "1.250.000đ"
String money(Object? value) => '${vnd(value)}đ';

/// 1234.5 -> "1.234,5"; 18 -> "18"; 0.25 -> "0,25"
String qty(Object? value) {
  final n = _toNum(value).toDouble();
  final neg = n < 0;
  final fixed = n.abs().toStringAsFixed(3).replaceFirst(RegExp(r'\.?0+$'), '');
  final parts = fixed.split('.');
  final s = _group(parts[0]) + (parts.length > 1 ? ',${parts[1]}' : '');
  return neg ? '−$s' : s;
}

/// 66.6 -> "66,6%"
String pct(Object? value, [int digits = 1]) => '${_toNum(value).toStringAsFixed(digits).replaceAll('.', ',')}%';

/// Signed change for ledgers: +1.000 / −600
String signed(Object? value) {
  final n = _toNum(value);
  return n > 0 ? '+${qty(n)}' : qty(n);
}

DateTime? parseDate(Object? v) {
  if (v == null) return null;
  if (v is DateTime) return v;
  return DateTime.tryParse('$v');
}

String _two(int n) => n.toString().padLeft(2, '0');

/// Shop time (UTC+7) like fmtTime on the web: "14/10/2026 09:41"
String shopTime(Object? v) {
  final d = parseDate(v);
  if (d == null) return '—';
  final t = d.toUtc().add(const Duration(hours: 7));
  return '${_two(t.day)}/${_two(t.month)}/${t.year} ${_two(t.hour)}:${_two(t.minute)}';
}

/// "14/10/2026"
String shopDay(Object? v) {
  final s = shopTime(v);
  return s == '—' ? s : s.split(' ').first;
}

/// "09:41"
String shopClock(Object? v) {
  final s = shopTime(v);
  return s == '—' ? s : s.split(' ').last;
}

/// yyyy-MM-dd of a shop day, for API query strings.
String isoDay(DateTime local) => '${local.year}-${_two(local.month)}-${_two(local.day)}';

/// "5 phút trước", "2 giờ trước", "3 ngày trước"
String ago(Object? v, {DateTime? now}) {
  final d = parseDate(v);
  if (d == null) return '—';
  final diff = (now ?? DateTime.now()).difference(d);
  if (diff.inMinutes < 1) return 'vừa xong';
  if (diff.inHours < 1) return '${diff.inMinutes} phút trước';
  if (diff.inDays < 1) return '${diff.inHours} giờ trước';
  return '${diff.inDays} ngày trước';
}

/// First letter for photo placeholders (same as the web's initial tiles).
String initial(String? name) {
  final s = (name ?? '').trim();
  return s.isEmpty ? '?' : s.characters.first.toUpperCase();
}

extension on String {
  _Chars get characters => _Chars(this);
}

class _Chars {
  _Chars(this.s);
  final String s;
  String get first => String.fromCharCodes(s.runes.take(1));
}
