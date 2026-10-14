import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import '../../core/theme/app_theme.dart';
import '../menu/form_sheet.dart';
import 'table_models.dart';

/// table-dialog in tables.ejs: "Thêm bàn" (POST /api/tables) or "Sửa bàn" (PUT /api/tables/:id).
/// Pops the saved code.
class TableForm extends ConsumerStatefulWidget {
  const TableForm({super.key, this.table});
  final DiningTable? table;

  @override
  ConsumerState<TableForm> createState() => _TableFormState();
}

class _TableFormState extends ConsumerState<TableForm> {
  final _form = GlobalKey<FormState>();
  late final _code = TextEditingController(text: widget.table?.code ?? '');
  late final _name = TextEditingController(text: widget.table?.name ?? '');
  late final _capacity = TextEditingController(text: '${widget.table?.capacity ?? 4}');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    _capacity.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final body = {'code': _code.text.trim(), 'name': _name.text.trim(), 'capacity': int.parse(_capacity.text.trim())};
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiProvider);
      final t = widget.table;
      if (t == null) {
        await api.post('/tables', body);
      } else {
        await api.put('/tables/${t.id}', body);
      }
      if (mounted) Navigator.of(context).pop(body['code']);
    } catch (e) {
      if (mounted) setState(() => _error = toApiException(e).message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FormSheet(
      formKey: _form,
      title: widget.table == null ? 'Thêm bàn' : 'Sửa bàn',
      busy: _busy,
      error: _error,
      onSubmit: _submit,
      children: [
        LabeledField(
          label: 'Mã bàn',
          child: TextFormField(
            controller: _code,
            maxLength: 20,
            buildCounter: _noCounter,
            autocorrect: false,
            textInputAction: TextInputAction.next,
            style: const TextStyle(fontFamily: 'monospace'),
            decoration: const InputDecoration(hintText: 'B01'),
            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập mã bàn' : null,
          ),
        ),
        LabeledField(
          label: 'Tên bàn',
          child: TextFormField(
            controller: _name,
            maxLength: 60,
            buildCounter: _noCounter,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(hintText: 'Bàn 1'),
            validator: (v) => (v ?? '').trim().isEmpty ? 'Nhập tên bàn' : null,
          ),
        ),
        LabeledField(
          label: 'Sức chứa',
          child: TextFormField(
            controller: _capacity,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(fontFeatures: tabular),
            validator: (v) {
              final n = int.tryParse((v ?? '').trim());
              return n == null || n < 1 || n > 100 ? 'Sức chứa từ 1 đến 100' : null;
            },
          ),
        ),
      ],
    );
  }
}

Widget? _noCounter(BuildContext context, {required int currentLength, required bool isFocused, required int? maxLength}) => null;
