import 'package:cocoffee_mobile/features/heli/heli_wake.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('foldVietnamese keeps the length', () {
    for (final s in ['Hê Li, hôm nay bao nhiêu đơn?', 'ĐƠN HÀNG', 'Heli']) {
      expect(foldVietnamese(s).length, s.length);
    }
    expect(foldVietnamese('Đơn hàng Hê Li'), 'don hang he li');
  });

  group('matchWake hears the name', () {
    final cases = {
      'Heli hôm nay bao nhiêu đơn': 'hôm nay bao nhiêu đơn',
      'heli, hôm nay bao nhiêu đơn?': 'hôm nay bao nhiêu đơn?',
      'Hê li doanh thu hôm nay': 'doanh thu hôm nay',
      'hey li mấy giờ rồi': 'mấy giờ rồi',
      'Hi li cho mình số đơn': 'cho mình số đơn',
      'e li tồn kho': 'tồn kho',
      'Helly doanh thu': 'doanh thu',
      'HÊ LI doanh thu': 'doanh thu',
      'hôm nay bao nhiêu đơn heli': 'hôm nay bao nhiêu đơn', // name said last
    };
    cases.forEach((said, command) {
      test(said, () => expect(matchWake(said)?.command, command));
    });
    test('only the name', () => expect(matchWake('Heli')?.command, ''));
  });

  group('matchWake ignores other speech', () {
    for (final said in ['hôm nay bao nhiêu đơn', 'cho tôi một ly cà phê', 'xe li ti', 'helicopter bay', 'hello', 'hell no']) {
      test(said, () => expect(matchWake(said), isNull));
    }
  });

  group('decideWake', () {
    final t0 = DateTime(2026, 10, 16, 9);

    test('no name and no follow-up window: ignored, nothing to send', () {
      expect(decideWake('hôm nay bao nhiêu đơn', now: t0), isA<WakeIgnore>());
      expect(decideWake('hôm nay bao nhiêu đơn', now: t0, activeUntil: t0.subtract(const Duration(seconds: 1))), isA<WakeIgnore>());
      expect(decideWake('   ', now: t0), isA<WakeIgnore>());
    });

    test('only "Heli": call', () => expect(decideWake('Heli', now: t0), isA<WakeCalled>()));

    test('name + question: the question', () {
      final d = decideWake('Heli, doanh thu hôm nay', now: t0);
      expect(d, isA<WakeCommand>().having((x) => x.text, 'text', 'doanh thu hôm nay'));
    });

    test('inside the 20 s window no name is needed', () {
      final until = t0.add(kHeliFollowUp);
      final d = decideWake('còn đơn hôm qua thì sao', now: t0.add(const Duration(seconds: 19)), activeUntil: until);
      expect(d, isA<WakeCommand>().having((x) => x.text, 'text', 'còn đơn hôm qua thì sao'));
      expect(decideWake('còn đơn hôm qua thì sao', now: t0.add(const Duration(seconds: 21)), activeUntil: until), isA<WakeIgnore>());
    });
  });
}
