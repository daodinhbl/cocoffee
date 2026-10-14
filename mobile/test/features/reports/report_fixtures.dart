/// Realistic answers of GET /api/admin/reports (snake_case keys, some numbers as MySQL DECIMAL strings).
library;

const _days = <String, (int, num, num)>{
  '2026-10-08': (42, 1850000, 610000),
  '2026-10-09': (38, 1620000, 540000),
  '2026-10-10': (0, 0, 0),
  '2026-10-11': (55, 2480000, 820000),
  '2026-10-12': (61, 2735000, 905000),
  '2026-10-13': (47, 2010000, 668000),
  '2026-10-14': (19, 815000, 270000),
};

const _hours = <int, (int, num)>{
  6: (8, 310000),
  7: (29, 1240000),
  8: (44, 2170000),
  9: (37, 1580000),
  10: (25, 1050000),
  11: (18, 760000),
  12: (14, 590000),
  13: (12, 520000),
  14: (16, 700000),
  15: (21, 930000),
  16: (17, 740000),
  17: (11, 470000),
  18: (6, 260000),
  19: (4, 190000),
};

String _add(String day, int n) {
  final d = DateTime.utc(int.parse(day.substring(0, 4)), int.parse(day.substring(5, 7)), int.parse(day.substring(8, 10)), 12)
      .add(Duration(days: n));
  return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

const presetsJson = [
  {'key': 'today', 'label': 'Hôm nay', 'from': '2026-10-14', 'to': '2026-10-14'},
  {'key': 'yesterday', 'label': 'Hôm qua', 'from': '2026-10-13', 'to': '2026-10-13'},
  {'key': '7d', 'label': '7 ngày', 'from': '2026-10-08', 'to': '2026-10-14'},
  {'key': 'month', 'label': 'Tháng này', 'from': '2026-10-01', 'to': '2026-10-14'},
  {'key': 'last_month', 'label': 'Tháng trước', 'from': '2026-09-01', 'to': '2026-09-30'},
];

/// Week 08/10–14/10/2026: 262 orders, 11.510.000đ revenue, 3.813.000đ COGS, 245.000đ unpaid (Zalo).
/// Other ranges reuse the same days where they overlap and are empty elsewhere.
Map<String, dynamic> reportJson({String from = '2026-10-08', String to = '2026-10-14', bool clamped = false, bool empty = false}) {
  final days = <Map<String, dynamic>>[];
  var orders = 0;
  num revenue = 0, cogs = 0;
  for (var d = from; d.compareTo(to) <= 0; d = _add(d, 1)) {
    final v = empty ? null : _days[d];
    final o = v?.$1 ?? 0;
    orders += o;
    revenue += v?.$2 ?? 0;
    cogs += v?.$3 ?? 0;
    // the server sends DECIMAL sums as strings
    days.add({'day': d, 'orders': o, 'revenue': '${v?.$2 ?? 0}.00', 'cogs': '${v?.$3 ?? 0}.00'});
  }
  final week = !empty && from == '2026-10-08' && to == '2026-10-14';
  return {
    'range': {'from': from, 'to': to, 'clamped': clamped},
    'presets': presetsJson,
    'summary': {'orders': orders, 'revenue': revenue, 'cogs': cogs, 'gross_profit': revenue - cogs, 'unpaid': orders > 0 ? 245000 : 0},
    'avg_ticket': orders > 0 ? revenue / orders : 0,
    'margin': revenue > 0 ? (revenue - cogs) / revenue * 100 : 0,
    'days': days,
    'hours': [
      for (var h = 0; h < 24; h++)
        {'hour': h, 'orders': week ? (_hours[h]?.$1 ?? 0) : 0, 'revenue': week ? (_hours[h]?.$2 ?? 0) : 0},
    ],
    'by_source': orders == 0
        ? []
        : [
            {'source': 'pos', 'orders': 214, 'revenue': '9180000.00', 'cogs': '3040000.00'},
            {'source': 'zalo', 'orders': 48, 'revenue': '2330000.00', 'cogs': '773000.00'},
          ],
    'by_payment': orders == 0
        ? []
        : [
            {'method': 'cash', 'orders': 151, 'revenue': 6120000},
            {'method': 'transfer', 'orders': 97, 'revenue': 5145000},
            {'method': 'unpaid', 'orders': 14, 'revenue': 245000},
          ],
    'top_products': orders == 0
        ? []
        : [
            {'product_id': 3, 'product_name': 'Cà phê sữa đá', 'qty': '96.000', 'revenue': 2880000, 'cogs': 806400},
            {'product_id': 5, 'product_name': 'Bạc xỉu', 'qty': 71, 'revenue': 2343000, 'cogs': 702900},
            {'product_id': 9, 'product_name': 'Trà đào cam sả', 'qty': 44, 'revenue': 1980000, 'cogs': 594000},
            {'product_id': 12, 'product_name': 'Cà phê muối', 'qty': 38, 'revenue': 1330000, 'cogs': 452200},
            {'product_id': 17, 'product_name': 'Sinh tố bơ', 'qty': 21, 'revenue': 945000, 'cogs': 378000},
          ],
  };
}
