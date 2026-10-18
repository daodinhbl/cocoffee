import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// A tiny HTTP seam so the ngrok logic is testable without a network.
typedef HttpCall = Future<HttpAnswer> Function(String method, Uri url, {Map<String, String>? headers, String? body});

class HttpAnswer {
  const HttpAnswer(this.status, this.body);
  final int status;
  final String body;
}

Future<HttpAnswer> realHttp(String method, Uri url, {Map<String, String>? headers, String? body}) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
  try {
    final req = await client.openUrl(method, url);
    headers?.forEach(req.headers.set);
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(body));
    }
    final res = await req.close().timeout(const Duration(seconds: 20));
    return HttpAnswer(res.statusCode, await res.transform(utf8.decoder).join());
  } finally {
    client.close(force: true);
  }
}

class NgrokException implements Exception {
  NgrokException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// ngrok's REST API (api.ngrok.com), used to find or create the account's reserved ("static") domain, so the shop's public
/// address stays the same after every restart. Needs an API key from the ngrok dashboard (not the agent authtoken).
class NgrokApi {
  NgrokApi(this.apiKey, {HttpCall http = realHttp}) : _http = http;
  final String apiKey;
  final HttpCall _http;

  Map<String, String> get _h => {'Authorization': 'Bearer $apiKey', 'Ngrok-Version': '2', 'Accept': 'application/json'};

  /// Domains already reserved on the account (e.g. the free static domain every account gets).
  Future<List<String>> reservedDomains() async {
    final r = await _http('GET', Uri.parse('https://api.ngrok.com/reserved_domains'), headers: _h);
    _check(r);
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    return [for (final d in (j['reserved_domains'] as List? ?? const [])) '${(d as Map)['domain']}'];
  }

  Future<String> reserve(String domain) async {
    final r = await _http('POST', Uri.parse('https://api.ngrok.com/reserved_domains'), headers: _h, body: jsonEncode({'domain': domain, 'description': 'POS Tasotek'}));
    _check(r);
    return '${(jsonDecode(r.body) as Map)['domain'] ?? domain}';
  }

  void _check(HttpAnswer r) {
    if (r.status == 401 || r.status == 403) throw NgrokException('ngrok từ chối API key (sai, hết hạn hoặc không đủ quyền).');
    if (r.status == 429) throw NgrokException('ngrok đang giới hạn tốc độ, thử lại sau ít phút.');
    if (r.status >= 400) {
      var detail = '';
      try { detail = '${(jsonDecode(r.body) as Map)['msg'] ?? ''}'; } catch (_) {/* not JSON */}
      throw NgrokException('ngrok trả lỗi ${r.status}${detail.isEmpty ? '' : ': $detail'}');
    }
  }
}

/// A subdomain-safe slug of the shop's name: "Quán Cà Phê Cò" -> "quan-ca-phe-co".
String slugOf(String name) {
  const from = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
  const to = 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';
  final b = StringBuffer();
  for (final ch in name.toLowerCase().split('')) {
    final i = from.indexOf(ch);
    b.write(i >= 0 ? to[i] : ch);
  }
  final s = b.toString().replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
  return s.length > 30 ? s.substring(0, 30).replaceAll(RegExp(r'-+$'), '') : s;
}

/// Chooses the domain to use: one already on the account (first), otherwise tries to reserve `<slug>-<4 random>.ngrok-free.app`.
/// [current] is what is already stored: it is kept when the account still has it.
Future<String> pickDomain(NgrokApi api, {required String current, required String shopName, Random? random}) async {
  final existing = await api.reservedDomains();
  if (current.isNotEmpty && existing.contains(current)) return current;
  if (existing.isNotEmpty) return existing.first;
  final r = random ?? Random.secure();
  final suffix = List.generate(4, (_) => 'abcdefghijkmnpqrstuvwxyz23456789'[r.nextInt(32)]).join();
  final slug = slugOf(shopName);
  return api.reserve('${slug.isEmpty ? 'pos' : slug}-$suffix.ngrok-free.app');
}

/// Arguments of `ngrok`: an HTTP tunnel to the local web server, on the reserved domain when there is one.
List<String> ngrokArgs({required int port, required String configFile, String domain = '', String authToken = '', int agentPort = 4041}) => [
      'http',
      '$port',
      '--config=$configFile',
      if (authToken.isNotEmpty) '--authtoken=$authToken',
      if (domain.isNotEmpty) '--url=https://$domain',
      '--log=stdout',
      '--log-format=json',
    ];

/// The agent's local API (http://127.0.0.1:4040/api/tunnels): the public https address of the first tunnel, or null.
String? publicUrlFromTunnels(String json) {
  try {
    final j = jsonDecode(json) as Map<String, dynamic>;
    for (final t in (j['tunnels'] as List? ?? const [])) {
      final url = '${(t as Map)['public_url'] ?? ''}';
      if (url.startsWith('https://')) return url;
    }
  } catch (_) {/* agent not ready */}
  return null;
}

/// The agent writes JSON log lines; the reason a tunnel failed is in the `err` field of the line.
String? ngrokErrorFromLog(String line) {
  try {
    final j = jsonDecode(line) as Map<String, dynamic>;
    final err = '${j['err'] ?? ''}';
    if (err.isEmpty || err == 'null') return null;
    if (err.contains('ERR_NGROK_105') || err.contains('authentication failed')) return 'ngrok từ chối authtoken (sai hoặc đã bị thu hồi).';
    if (err.contains('ERR_NGROK_334') || err.contains('already online')) return 'Tên miền này đang được dùng bởi một tunnel khác (tắt tunnel cũ trên máy khác hoặc trong dashboard ngrok).';
    if (err.contains('ERR_NGROK_320') || err.contains('not reserved') || err.contains('ERR_NGROK_314')) return 'Tên miền chưa thuộc tài khoản ngrok này (đặt trước ở dashboard ngrok > Domains).';
    return err.length > 200 ? '${err.substring(0, 200)}…' : err;
  } catch (_) {
    return null;
  }
}

/// The vendor's broker (POST /api/ngrok/claim on the update server): a shop with a valid licence gets its own domain and a tunnel token
/// limited to that domain, so it needs no ngrok account of its own. Returns the domain and the token.
Future<({String domain, String authtoken})> claimBrokerDomain({
  required String server,
  required String machineId,
  required String licenseCode,
  required String shopName,
  HttpCall http = realHttp,
}) async {
  if (licenseCode.trim().isEmpty) throw NgrokException('Cần nhập mã kích hoạt ở tab Giấy phép trước (tên miền chỉ cấp cho máy có giấy phép).');
  final base = server.trim().replaceAll(RegExp(r'/+$'), '');
  if (!base.startsWith('https://') && !base.startsWith('http://127.0.0.1')) throw NgrokException('Địa chỉ máy chủ cấp tên miền phải là https://');
  HttpAnswer r;
  try {
    r = await http('POST', Uri.parse('$base/api/ngrok/claim'), headers: {'Accept': 'application/json'}, body: jsonEncode({'machine': machineId, 'code': licenseCode.trim(), 'shopName': shopName}));
  } catch (_) {
    throw NgrokException('Không kết nối được máy chủ cấp tên miền. Kiểm tra mạng.');
  }
  Map<String, dynamic>? j;
  try {
    j = jsonDecode(r.body) as Map<String, dynamic>;
  } catch (_) {/* not JSON */}
  if (r.status != 200) {
    final msg = j?['error'] is Map ? '${(j!['error'] as Map)['message'] ?? ''}' : '';
    throw NgrokException(msg.isNotEmpty ? msg : 'Máy chủ cấp tên miền trả lỗi ${r.status}.');
  }
  final domain = '${j?['domain'] ?? ''}', token = '${j?['authtoken'] ?? ''}';
  if (!RegExp(r'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$').hasMatch(domain) || token.isEmpty) throw NgrokException('Máy chủ cấp tên miền trả dữ liệu không hợp lệ.');
  return (domain: domain, authtoken: token);
}
