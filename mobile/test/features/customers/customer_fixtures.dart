/// Fake API payloads shaped exactly like the contract in api.json "gaps" (snake_case keys, numbers, ISO dates).
library;

Map<String, dynamic> customerJson({
  int id = 7,
  String name = 'Nguyễn Văn An',
  String? phone = '0901234567',
  String? zalo = 'zl_123456',
  String? note = 'Văn phòng tầng 3',
  num balance = 150000,
  int orders = 12,
}) =>
    {
      'id': id,
      'name': name,
      'phone': phone,
      'zalo_user_id': zalo,
      'note': note,
      'created_at': '2026-09-01T02:00:00.000Z',
      'updated_at': '2026-10-14T02:30:00.000Z',
      'balance': balance,
      'order_count': orders,
    };

Map<String, dynamic> customersPage({int page = 1, int pages = 3, int total = 60, List<Map<String, dynamic>>? customers}) => {
      'customers': customers ??
          [
            customerJson(),
            customerJson(id: 8, name: 'Trần Thị Bình', phone: null, zalo: null, note: null, balance: 0, orders: 3),
            customerJson(id: 9, name: 'Lê Minh Châu', phone: '0987654321', zalo: null, note: null, balance: -20000, orders: 1),
          ],
      'total': total,
      'page': page,
      'pages': pages,
      'page_size': 25,
      'stats': {'total_customers': 60, 'debt_customers': 4, 'total_debt': 1250000},
    };

Map<String, dynamic> customerDetail({num balance = 150000, bool settled = false}) => {
      'customer': customerJson(balance: balance),
      'ledger': [
        if (settled)
          {
            'id': 32,
            'entry_type': 'payment',
            'amount': -150000,
            'method': 'transfer',
            'note': 'CK Vietcombank',
            'created_at': '2026-10-14T04:00:00.000Z',
            'order_id': null,
            'order_code': null,
            'created_by_name': 'boss',
          },
        {
          'id': 31,
          'entry_type': 'payment',
          'amount': -50000,
          'method': 'cash',
          'note': null,
          'created_at': '2026-10-13T03:00:00.000Z',
          'order_id': null,
          'order_code': null,
          'created_by_name': 'boss',
        },
        {
          'id': 30,
          'entry_type': 'debt',
          'amount': 120000,
          'method': null,
          'note': 'Nợ đơn CF261012-00042',
          'created_at': '2026-10-12T05:00:00.000Z',
          'order_id': 42,
          'order_code': 'CF261012-00042',
          'created_by_name': null,
        },
        {
          'id': 29,
          'entry_type': 'adjust',
          'amount': 80000,
          'method': null,
          'note': 'nợ cũ ghi sổ tay',
          'created_at': '2026-10-01T01:00:00.000Z',
          'order_id': null,
          'order_code': null,
          'created_by_name': 'boss',
        },
      ],
      'orders': [
        {
          'id': 42,
          'order_code': 'CF261012-00042',
          'status': 'completed',
          'payment_status': settled ? 'paid' : 'unpaid',
          'total': 120000,
          'created_at': '2026-10-12T04:55:00.000Z',
          'completed_at': '2026-10-12T05:00:00.000Z',
          'source': 'zalo',
        },
        {
          'id': 40,
          'order_code': 'CF261010-00040',
          'status': 'completed',
          'payment_status': 'paid',
          'total': 45000,
          'created_at': '2026-10-10T08:00:00.000Z',
          'completed_at': '2026-10-10T08:20:00.000Z',
          'source': 'pos',
        },
      ],
    };

Map<String, dynamic> reconciliationJson({String from = '2026-10-01', String to = '2026-10-14', bool empty = false}) => {
      'period': {'from': from, 'to': to},
      'rows': empty
          ? <Map<String, dynamic>>[]
          : [
              {'id': 7, 'name': 'Nguyễn Văn An', 'phone': '0901234567', 'opening': 80000, 'increase': 120000, 'decrease': 50000, 'closing': 150000},
              {'id': 9, 'name': 'Lê Minh Châu', 'phone': null, 'opening': 30000, 'increase': 0, 'decrease': 30000, 'closing': 0},
            ],
      'totals': empty
          ? {'opening': 0, 'increase': 0, 'decrease': 0, 'closing': 0}
          : {'opening': 110000, 'increase': 120000, 'decrease': 80000, 'closing': 150000},
      'presets': [
        {'key': 'month', 'label': 'Tháng này', 'from': '2026-10-01', 'to': '2026-10-14'},
        {'key': 'last_month', 'label': 'Tháng trước', 'from': '2026-09-01', 'to': '2026-09-30'},
        {'key': 'year', 'label': 'Năm nay', 'from': '2026-01-01', 'to': '2026-10-14'},
      ],
    };
