import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import 'core/licensing.dart';

const _defaultDir = r'D:\FNB-secrets';

/// Phone/tablet build: keys and the ledger live in the app's own (sandboxed) documents folder; no folder picking.
bool get isMobile => Platform.isIOS || Platform.isAndroid;

void main() => runApp(const LicenseManagerApp());

class LicenseManagerApp extends StatelessWidget {
  const LicenseManagerApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Cấp phép POS Tasotek',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1E3A8A)),
          scaffoldBackgroundColor: const Color(0xFFFAF8F5),
          cardTheme: const CardThemeData(color: Colors.white, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10)), side: BorderSide(color: Color(0xFFE8E3DA)))),
        ),
        home: const HomeScreen(),
      );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String _dir = Platform.environment['TASOTEK_LICENSE_DIR'] ?? (isMobile ? '' : _defaultDir);
  bool _ready = !isMobile;
  VendorKey? _key;
  String? _keyError;
  int _tab = 0;
  late LicenseBook _book = LicenseBook(p.join(_dir, 'license-db.json'));

  @override
  void initState() {
    super.initState();
    if (isMobile) {
      getApplicationDocumentsDirectory().then((d) {
        if (!mounted) return;
        setState(() {
          _dir = p.join(d.path, 'tasotek-license');
          _book = LicenseBook(p.join(_dir, 'license-db.json'));
          _ready = true;
        });
        _loadKey();
      });
    } else {
      _loadKey();
    }
  }

  Future<void> _loadKey() async {
    try {
      final k = await VendorKey.load(p.join(_dir, 'license-private.pem'));
      if (mounted) {
        setState(() {
          _key = k;
          _keyError = null;
        });
      }
    } on LicenseError catch (e) {
      if (mounted) {
        setState(() {
          _key = null;
          _keyError = e.message;
        });
      }
    }
  }

  void _setDir(String dir) {
    setState(() {
      _dir = dir;
      _book = LicenseBook(p.join(dir, 'license-db.json'));
    });
    _loadKey();
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final pages = [
      IssuePage(key: ValueKey('issue$_dir'), keyPair: _key, book: _book, onIssued: () => setState(() {})),
      ListPage(key: ValueKey('list$_dir${_book.read().length}'), keyPair: _key, book: _book, changed: () => setState(() {})),
      VerifyPage(publicHex: _key?.publicHex),
      KeyPage(dir: _dir, keyPair: _key, error: _keyError, onDir: _setDir, onCreated: _loadKey),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cấp phép POS Tasotek Server'),
        backgroundColor: const Color(0xFF172554),
        foregroundColor: Colors.white,
        actions: [Padding(padding: const EdgeInsets.only(right: 16), child: Center(child: Text(_key == null ? 'Chưa có khóa' : 'Khóa: ${_key!.publicHex.substring(0, 12)}…', style: const TextStyle(fontSize: 13))))],
      ),
      bottomNavigationBar: isMobile
          ? NavigationBar(
              selectedIndex: _tab,
              onDestinationSelected: (i) => setState(() => _tab = i),
              destinations: const [
                NavigationDestination(icon: Icon(Icons.add_moderator_rounded), label: 'Cấp mã'),
                NavigationDestination(icon: Icon(Icons.list_alt_rounded), label: 'Đã cấp'),
                NavigationDestination(icon: Icon(Icons.fact_check_rounded), label: 'Kiểm tra'),
                NavigationDestination(icon: Icon(Icons.key_rounded), label: 'Khóa'),
              ],
            )
          : null,
      body: isMobile ? SafeArea(child: pages[_tab]) : Row(children: [
        NavigationRail(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          labelType: NavigationRailLabelType.all,
          destinations: const [
            NavigationRailDestination(icon: Icon(Icons.add_moderator_rounded), label: Text('Cấp mã')),
            NavigationRailDestination(icon: Icon(Icons.list_alt_rounded), label: Text('Đã cấp')),
            NavigationRailDestination(icon: Icon(Icons.fact_check_rounded), label: Text('Kiểm tra mã')),
            NavigationRailDestination(icon: Icon(Icons.key_rounded), label: Text('Khóa')),
          ],
        ),
        const VerticalDivider(width: 1),
        Expanded(child: pages[_tab]),
      ]),
    );
  }
}

String dmy(DateTime d) => '${d.toLocal().day.toString().padLeft(2, '0')}/${d.toLocal().month.toString().padLeft(2, '0')}/${d.toLocal().year}';

Future<void> copy(BuildContext context, String text, String what) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Đã sao chép $what.')));
}

// ------------------------------------------------------------------ issue
class IssuePage extends StatefulWidget {
  const IssuePage({super.key, required this.keyPair, required this.book, required this.onIssued});
  final VendorKey? keyPair;
  final LicenseBook book;
  final VoidCallback onIssued;
  @override
  State<IssuePage> createState() => _IssuePageState();
}

class _IssuePageState extends State<IssuePage> {
  final _machine = TextEditingController();
  final _customer = TextEditingController();
  final _days = TextEditingController(text: '365');
  final _note = TextEditingController();
  final _features = <String>{'pos'};
  String? _error;
  IssuedLicense? _last;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_machine, _customer, _days, _note]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _issue() async {
    final key = widget.keyPair;
    if (key == null) {
      setState(() => _error = 'Chưa có khóa riêng: mở tab Khóa để tạo hoặc chọn thư mục.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rec = await widget.book.issue(key, machine: _machine.text, customer: _customer.text, days: int.tryParse(_days.text.trim()) ?? 0, features: _features.toList(), note: _note.text);
      setState(() => _last = rec);
      widget.onIssued();
      if (mounted) await copy(context, rec.code, 'mã kích hoạt');
    } on LicenseError catch (e) {
      setState(() => _error = e.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(24), children: [
      Text('Cấp mã kích hoạt mới', style: t.titleLarge),
      const SizedBox(height: 4),
      Text('Khách mở chương trình POS Tasotek Server, vào tab Giấy phép, sao chép Mã máy gửi cho bạn. Dán vào đây rồi cấp mã.', style: t.bodySmall),
      const SizedBox(height: 16),
      TextField(
        controller: _machine,
        style: const TextStyle(fontFamily: 'Consolas', fontSize: 16),
        decoration: const InputDecoration(labelText: 'Mã máy của khách', hintText: 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90', border: OutlineInputBorder()),
        onChanged: (v) {
          final n = normalizeMachineId(v);
          if (n != v && RegExp(r'^[0-9A-F]{4}(-[0-9A-F]{4}){7}$').hasMatch(n)) {
            _machine.value = TextEditingValue(text: n, selection: TextSelection.collapsed(offset: n.length));
          }
        },
      ),
      const SizedBox(height: 12),
      Row(children: [
        Expanded(flex: 3, child: TextField(controller: _customer, decoration: const InputDecoration(labelText: 'Khách hàng', border: OutlineInputBorder()))),
        const SizedBox(width: 12),
        SizedBox(width: 160, child: TextField(controller: _days, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Số ngày hiệu lực', border: OutlineInputBorder()))),
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 8, children: [
        for (final d in const [30, 90, 180, 365, 730]) ActionChip(label: Text('$d ngày'), onPressed: () => setState(() => _days.text = '$d')),
      ]),
      const SizedBox(height: 12),
      Wrap(spacing: 12, children: [
        for (final f in kFeatures)
          FilterChip(label: Text(f), selected: _features.contains(f), onSelected: (s) => setState(() => s ? _features.add(f) : _features.remove(f))),
      ]),
      const SizedBox(height: 12),
      TextField(controller: _note, maxLength: 120, decoration: const InputDecoration(labelText: 'Ghi chú nội bộ (không nằm trong mã)', border: OutlineInputBorder())),
      const SizedBox(height: 8),
      FilledButton.icon(onPressed: _busy ? null : _issue, icon: const Icon(Icons.verified_rounded), label: const Text('Cấp mã và sao chép')),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
      if (_last != null) ...[
        const SizedBox(height: 20),
        Card(
          color: const Color(0xFFD1FAE5),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Đã cấp cho ${_last!.payload.customer} · hết hạn ${dmy(_last!.payload.expires)}', style: t.titleSmall),
              const SizedBox(height: 8),
              SelectableText(_last!.code, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12)),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => copy(context, _last!.code, 'mã kích hoạt'), icon: const Icon(Icons.copy_rounded, size: 18), label: const Text('Sao chép lại')),
            ]),
          ),
        ),
      ],
    ]);
  }
}

// ------------------------------------------------------------------ list
class ListPage extends StatefulWidget {
  const ListPage({super.key, required this.keyPair, required this.book, required this.changed});
  final VendorKey? keyPair;
  final LicenseBook book;
  final VoidCallback changed;
  @override
  State<ListPage> createState() => _ListPageState();
}

class _ListPageState extends State<ListPage> {
  String _q = '';
  String? _msg;

  Future<void> _renew(IssuedLicense l) async {
    final key = widget.keyPair;
    if (key == null) {
      setState(() => _msg = 'Chưa có khóa riêng.');
      return;
    }
    final days = TextEditingController(text: '365');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Gia hạn cho ${l.payload.customer}'),
        content: TextField(controller: days, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Số ngày hiệu lực kể từ hôm nay')),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Hủy')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Cấp mã mới'))],
      ),
    );
    final n = int.tryParse(days.text.trim()) ?? 0;
    days.dispose();
    if (ok != true) return;
    try {
      final rec = await widget.book.renew(key, l.id, n);
      if (mounted) await copy(context, rec.code, 'mã gia hạn');
      widget.changed();
      setState(() => _msg = 'Đã gia hạn ${rec.payload.customer} đến ${dmy(rec.payload.expires)} (mã mới đã được sao chép).');
    } on LicenseError catch (e) {
      setState(() => _msg = e.message);
    }
  }

  Future<void> _revoke(IssuedLicense l) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Thu hồi mã của ${l.payload.customer}?'),
        content: const Text('Chỉ đánh dấu trong sổ và không gia hạn nữa. Mã cũ đã gửi cho khách vẫn chạy đến ngày hết hạn (mã kiểm tra offline).'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Hủy')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Thu hồi'))],
      ),
    );
    if (ok != true) return;
    try {
      widget.book.revoke(l.id);
      widget.changed();
    } on LicenseError catch (e) {
      setState(() => _msg = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final all = widget.book.read().reversed.where((l) => _q.isEmpty || l.payload.customer.toLowerCase().contains(_q) || l.payload.machine.contains(_q.toUpperCase()) || l.note.toLowerCase().contains(_q)).toList();
    final colors = [Colors.green.shade700, Colors.amber.shade800, Colors.red.shade700];
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Đã cấp (${widget.book.read().length})', style: Theme.of(context).textTheme.titleLarge),
          const Spacer(),
          SizedBox(width: 260, child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Tìm khách / mã máy', isDense: true, border: OutlineInputBorder()), onChanged: (v) => setState(() => _q = v.trim().toLowerCase()))),
          const SizedBox(width: 8),
          PopupMenuButton<String>(
            tooltip: 'Đồng bộ sổ giữa các thiết bị',
            icon: const Icon(Icons.sync_rounded),
            onSelected: (v) async {
              if (v == 'copy') {
                await Clipboard.setData(ClipboardData(text: widget.book.exportJson()));
                setState(() => _msg = 'Đã sao chép sổ. Mở app ở thiết bị kia, chọn "Dán và gộp sổ".');
                return;
              }
              final key = widget.keyPair;
              final data = await Clipboard.getData(Clipboard.kTextPlain);
              if (key == null) {
                setState(() => _msg = 'Cần có khóa riêng để kiểm tra mã trước khi gộp.');
                return;
              }
              try {
                final r = await widget.book.mergeJson(data?.text ?? '', key.publicHex);
                widget.changed();
                setState(() => _msg = 'Đã gộp sổ: thêm ${r.added}, cập nhật ${r.updated}, bỏ qua ${r.refused} dòng không hợp lệ.');
              } on LicenseError catch (e) {
                setState(() => _msg = e.message);
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'copy', child: Text('Sao chép sổ (gửi sang thiết bị khác)')),
              PopupMenuItem(value: 'paste', child: Text('Dán và gộp sổ từ thiết bị khác')),
            ],
          ),
          OutlinedButton.icon(
            onPressed: () async {
              final f = File(p.join(p.dirname(widget.book.file), 'danh-sach-cap-phep.csv'))..writeAsStringSync(widget.book.csv());
              if (isMobile) {
                await SharePlus.instance.share(ShareParams(files: [XFile(f.path)], subject: 'Danh sách cấp phép'));
              } else {
                setState(() => _msg = 'Đã xuất ${f.path}');
              }
            },
            icon: const Icon(Icons.table_view_rounded, size: 18),
            label: const Text('Xuất CSV'),
          ),
        ]),
        if (_msg != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_msg!, style: TextStyle(color: Theme.of(context).colorScheme.primary))),
        const SizedBox(height: 12),
        Expanded(
          child: Card(
            child: all.isEmpty
                ? const Center(child: Text('Chưa cấp mã nào.'))
                : ListView.separated(
                    itemCount: all.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final l = all[i];
                      final (label, sev) = l.statusLabel(now);
                      return ListTile(
                        title: Text(l.payload.customer, style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text('${l.payload.machine}\nCấp ${dmy(l.payload.issued)} · hết hạn ${dmy(l.payload.expires)} · ${l.payload.features.join(', ')}${l.note.isEmpty ? '' : '\n${l.note}'}'),
                        isThreeLine: true,
                        leading: Icon(Icons.circle, size: 14, color: colors[sev]),
                        trailing: Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                          Text(label, style: TextStyle(color: colors[sev], fontWeight: FontWeight.w600)),
                          IconButton(tooltip: 'Sao chép mã', icon: const Icon(Icons.copy_rounded), onPressed: () => copy(context, l.code, 'mã kích hoạt')),
                          if (l.isActive) IconButton(tooltip: 'Gia hạn', icon: const Icon(Icons.autorenew_rounded), onPressed: () => _renew(l)),
                          if (l.isActive) IconButton(tooltip: 'Thu hồi', icon: Icon(Icons.block_rounded, color: Colors.red.shade700), onPressed: () => _revoke(l)),
                        ]),
                      );
                    },
                  ),
          ),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------ verify
class VerifyPage extends StatefulWidget {
  const VerifyPage({super.key, required this.publicHex});
  final String? publicHex;
  @override
  State<VerifyPage> createState() => _VerifyPageState();
}

class _VerifyPageState extends State<VerifyPage> {
  final _code = TextEditingController();
  String? _result;
  bool _ok = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    if (widget.publicHex == null) {
      setState(() {
        _ok = false;
        _result = 'Chưa có khóa để kiểm tra chữ ký.';
      });
      return;
    }
    try {
      final d = await decodeCode(_code.text, widget.publicHex!);
      final left = d.payload.expires.difference(DateTime.now().toUtc()).inDays;
      setState(() {
        _ok = d.signatureValid;
        _result = '${d.signatureValid ? '✔ Chữ ký hợp lệ' : '✖ CHỮ KÝ KHÔNG HỢP LỆ (mã bị sửa hoặc do khóa khác cấp)'}\n'
            'Khách hàng: ${d.payload.customer}\nMã máy: ${d.payload.machine}\nCấp: ${dmy(d.payload.issued)}\n'
            'Hết hạn: ${dmy(d.payload.expires)} (${left < 0 ? 'đã hết hạn' : 'còn $left ngày'})\nTính năng: ${d.payload.features.join(', ')}';
      });
    } on LicenseError catch (e) {
      setState(() {
        _ok = false;
        _result = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(24), children: [
      Text('Kiểm tra mã kích hoạt', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 4),
      const Text('Dán mã khách gửi (hoặc mã cũ) để xem nội dung và kiểm tra chữ ký bằng khóa của bạn.'),
      const SizedBox(height: 12),
      TextField(controller: _code, minLines: 4, maxLines: 8, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12), decoration: const InputDecoration(border: OutlineInputBorder()), autocorrect: false),
      const SizedBox(height: 8),
      FilledButton.icon(onPressed: _check, icon: const Icon(Icons.fact_check_rounded), label: const Text('Kiểm tra')),
      if (_result != null) Padding(padding: const EdgeInsets.only(top: 16), child: Card(color: _ok ? const Color(0xFFD1FAE5) : const Color(0xFFFEE2E2), child: Padding(padding: const EdgeInsets.all(16), child: SelectableText(_result!)))),
    ]);
  }
}

// ------------------------------------------------------------------ key
class KeyPage extends StatefulWidget {
  const KeyPage({super.key, required this.dir, required this.keyPair, required this.error, required this.onDir, required this.onCreated});
  final String dir;
  final VendorKey? keyPair;
  final String? error;
  final void Function(String) onDir;
  final VoidCallback onCreated;
  @override
  State<KeyPage> createState() => _KeyPageState();
}

class _KeyPageState extends State<KeyPage> {
  late final _dir = TextEditingController(text: widget.dir);
  String? _msg;

  @override
  void dispose() {
    _dir.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    try {
      await VendorKey.create(p.join(_dir.text.trim(), 'license-private.pem'));
      widget.onCreated();
      setState(() => _msg = 'Đã tạo khóa mới. SAO LƯU file license-private.pem ra nơi an toàn; mất nó thì không cấp mã mới được.');
    } on LicenseError catch (e) {
      setState(() => _msg = e.message);
    }
  }

  /// Mobile: paste the PEM saved from the Windows tool (or a backup of this app's key).
  Future<void> _import() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    try {
      await VendorKey.importPem(p.join(_dir.text.trim(), 'license-private.pem'), data?.text ?? '');
      widget.onCreated();
      setState(() => _msg = 'Đã nhập khóa riêng từ bộ nhớ tạm.');
    } on LicenseError catch (e) {
      setState(() => _msg = 'Sao chép nội dung file license-private.pem rồi bấm lại. ${e.message}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final k = widget.keyPair;
    return ListView(padding: const EdgeInsets.all(24), children: [
      Text('Khóa cấp phép', style: t.titleLarge),
      const SizedBox(height: 4),
      const Text('Khóa riêng (Ed25519) nằm trong thư mục bên dưới, chỉ trên máy này. Sổ mã đã cấp (license-db.json) cũng lưu ở đây.'),
      const SizedBox(height: 12),
      if (!isMobile) Row(children: [
        Expanded(child: TextField(controller: _dir, decoration: const InputDecoration(labelText: 'Thư mục khóa và sổ', border: OutlineInputBorder()))),
        const SizedBox(width: 8),
        FilledButton(onPressed: () => widget.onDir(_dir.text.trim()), child: const Text('Dùng thư mục này')),
      ]),
      const SizedBox(height: 16),
      if (k != null) ...[
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Row(children: [Icon(Icons.check_circle_rounded, color: Colors.green), SizedBox(width: 8), Text('Đã nạp khóa riêng')]),
              const SizedBox(height: 8),
              Text('Khóa công khai (nhúng vào chương trình của khách, hằng kLicensePublicKeyHex):', style: t.bodySmall),
              SelectableText(k.publicHex, style: const TextStyle(fontFamily: 'Consolas', fontSize: 13)),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => copy(context, k.publicHex, 'khóa công khai'), icon: const Icon(Icons.copy_rounded, size: 18), label: const Text('Sao chép khóa công khai')),
              if (isMobile) ...[
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () => SharePlus.instance.share(ShareParams(files: [XFile(k.file)], subject: 'Sao lưu khóa riêng POS Tasotek')),
                  icon: const Icon(Icons.ios_share_rounded, size: 18),
                  label: const Text('Sao lưu khóa riêng (cất nơi an toàn)'),
                ),
              ],
            ]),
          ),
        ),
      ] else ...[
        Card(
          color: const Color(0xFFFEF3C7),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.error ?? 'Chưa có khóa riêng.'),
              const SizedBox(height: 8),
              FilledButton.icon(onPressed: _create, icon: const Icon(Icons.vpn_key_rounded), label: const Text('Tạo khóa mới tại thư mục này')),
              if (isMobile) ...[
                const SizedBox(height: 8),
                OutlinedButton.icon(onPressed: _import, icon: const Icon(Icons.content_paste_rounded), label: const Text('Dán khóa riêng đã sao lưu (PEM)')),
              ],
              const SizedBox(height: 4),
              const Text('Chú ý: nếu tạo khóa mới thì chương trình của khách (đã nhúng khóa công khai cũ) sẽ không nhận mã mới; phải phát hành lại bản cài với khóa công khai mới.', style: TextStyle(fontSize: 12)),
            ]),
          ),
        ),
      ],
      if (_msg != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_msg!)),
    ]);
  }
}
