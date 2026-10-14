import 'package:cocoffee_mobile/features/reports/report_models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'report_fixtures.dart';

void main() {
  test('parses the API answer, DECIMAL strings included', () {
    final r = ReportData.fromJson(reportJson());
    expect(r.from, '2026-10-08');
    expect(r.to, '2026-10-14');
    expect(r.clamped, isFalse);
    expect(r.summary.orders, 262);
    expect(r.summary.revenue, 11510000);
    expect(r.summary.grossProfit, 7697000);
    expect(r.avgTicket, closeTo(43931.3, 0.1));
    expect(r.margin, closeTo(66.87, 0.01));
    expect(r.days, hasLength(7));
    expect(r.days[4].revenue, 2735000);
    expect(r.days[4].profit, 1830000);
    expect(r.hours, hasLength(24));
    expect(r.hours[8].orders, 44);
    expect(r.bySource.first.label, 'POS');
    expect(r.bySource.first.revenue, 9180000);
    expect(r.byPayment.map((p) => p.label), ['Tiền mặt', 'Chuyển khoản', 'Chưa thu']);
    expect(r.top.first.qty, 96);
    expect(r.presets.map((p) => p.label), ['Hôm nay', 'Hôm qua', '7 ngày', 'Tháng này', 'Tháng trước']);
    expect(r.isActive(r.presets[2]), isTrue);
    expect(r.isActive(r.presets[0]), isFalse);
  });

  test('fills missing days and hours, falls back to the web presets', () {
    final r = ReportData.fromJson({
      'range': {'from': '2026-09-29', 'to': '2026-10-02', 'clamped': true},
      'summary': {'orders': 3, 'revenue': '90000.00', 'cogs': '30000.00'},
      'days': [
        {'day': '2026-09-30', 'orders': 3, 'revenue': '90000.00', 'cogs': '30000.00'},
      ],
      'hours': [
        {'hour': 9, 'orders': 3, 'revenue': 90000},
      ],
    }, today: '2026-10-14');
    expect(r.clamped, isTrue);
    expect(r.days.map((d) => d.day), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(r.days[1].orders, 3);
    expect(r.days[2].orders, 0);
    expect(r.hours, hasLength(24));
    expect(r.hours[9].revenue, 90000);
    expect(r.summary.grossProfit, 60000); // revenue − cogs when gross_profit is absent
    expect(r.avgTicket, 30000);
    final p = {for (final x in r.presets) x.key: '${x.from}..${x.to}'};
    expect(p['today'], '2026-10-14..2026-10-14');
    expect(p['yesterday'], '2026-10-13..2026-10-13');
    expect(p['7d'], '2026-10-08..2026-10-14');
    expect(p['month'], '2026-10-01..2026-10-14');
    expect(p['last_month'], '2026-09-01..2026-09-30');
  });

  test('day helpers', () {
    expect(addDays('2026-01-01', -1), '2025-12-31');
    expect(addDays('2026-02-28', 1), '2026-03-01');
    expect(dayLabel('2026-10-14'), '14/10');
    expect(rangeText('2026-10-14', '2026-10-14'), '14/10/2026');
    expect(rangeText('2026-10-08', '2026-10-14'), '08/10/2026 – 14/10/2026');
    expect(normalizeDay('2026-10-13T17:30:00.000Z'), '2026-10-14');
    expect(normalizeDay('2026-10-13'), '2026-10-13');
    expect(shopToday(DateTime.utc(2026, 10, 13, 18)), '2026-10-14');
    expect(share(9180000, 11510000), '79,8%');
    expect(share(0, 0), '—');
  });

  test('axis ticks are round and cover the maximum', () {
    expect(niceTicks(2735000), [0, 1000000, 2000000, 3000000]);
    expect(niceTicks(900000), [0, 250000, 500000, 750000, 1000000]);
    expect(niceTicks(2170000), [0, 1000000, 2000000, 3000000]);
    expect(niceTicks(4000000), [0, 1000000, 2000000, 3000000, 4000000]);
    expect(niceTicks(0), [0]);
    expect(compactMoney(0), '0');
    expect(compactMoney(750), '750');
    expect(compactMoney(250000), '250k');
    expect(compactMoney(2500000), '2,5tr');
    expect(compactMoney(1000000), '1tr');
    expect(compactMoney(1500000000), '1,5 tỷ');
  });
}
