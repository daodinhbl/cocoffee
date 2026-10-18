import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pos_tasotek_server/core/ngrok.dart';

void main() {
  const machine = 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90';

  test('broker: sends machine + code, returns domain and token', () async {
    late Map<String, dynamic> sent;
    final r = await claimBrokerDomain(
      server: 'https://shop.example/',
      machineId: machine,
      licenseCode: ' code.sig ',
      shopName: 'Cò',
      http: (m, u, {headers, body}) async {
        expect(u.toString(), 'https://shop.example/api/ngrok/claim');
        sent = jsonDecode(body!) as Map<String, dynamic>;
        return HttpAnswer(200, jsonEncode({'domain': 'co-1a2b.ngrok.app', 'authtoken': '2tok'}));
      },
    );
    expect(sent['code'], 'code.sig');
    expect(sent['machine'], machine);
    expect((r.domain, r.authtoken), ('co-1a2b.ngrok.app', '2tok'));
  });

  test('broker: no licence, bad server, error answers and junk are explained', () async {
    HttpCall answering(int s, String b) => (m, u, {headers, body}) async => HttpAnswer(s, b);
    await expectLater(claimBrokerDomain(server: 'https://x', machineId: machine, licenseCode: '', shopName: 'a'), throwsA(isA<NgrokException>()));
    await expectLater(claimBrokerDomain(server: 'http://evil.example', machineId: machine, licenseCode: 'c', shopName: 'a'), throwsA(isA<NgrokException>()));
    await expectLater(
      claimBrokerDomain(server: 'https://x', machineId: machine, licenseCode: 'c', shopName: 'a', http: answering(403, jsonEncode({'error': {'message': 'Mã kích hoạt đã hết hạn.'}}))),
      throwsA(isA<NgrokException>().having((e) => e.message, 'message', 'Mã kích hoạt đã hết hạn.')),
    );
    await expectLater(claimBrokerDomain(server: 'https://x', machineId: machine, licenseCode: 'c', shopName: 'a', http: answering(200, jsonEncode({'domain': '../x', 'authtoken': 't'}))), throwsA(isA<NgrokException>()));
    await expectLater(claimBrokerDomain(server: 'https://x', machineId: machine, licenseCode: 'c', shopName: 'a', http: answering(500, '<html>')), throwsA(isA<NgrokException>()));
  });
}
