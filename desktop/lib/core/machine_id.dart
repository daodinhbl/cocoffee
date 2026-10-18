import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

/// The id of this PC, used to bind a licence to it. It is a hash of two things that stay the same for the life of an installation of
/// Windows on this disk, and differ on every other PC: the machine GUID Windows generates at setup, and the serial number of the
/// system drive. Cloning the data folder to another PC therefore gives a different id there.
///
/// Format: 8 groups of 4 hex characters, "A1B2-C3D4-...". The first 128 bits of SHA-256(`tasotek-pos|guid|serial`).
String machineIdFrom({required String guid, required String volumeSerial}) {
  final digest = sha256.convert(utf8.encode('tasotek-pos|${guid.trim().toLowerCase()}|${volumeSerial.trim().toUpperCase()}')).toString();
  final hex = digest.substring(0, 32).toUpperCase();
  return [for (var i = 0; i < 32; i += 4) hex.substring(i, i + 4)].join('-');
}

/// `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` -> the GUID (any Windows language).
String? parseMachineGuid(String output) {
  final m = RegExp(r'MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})').firstMatch(output);
  return m?.group(1);
}

/// `vol C:` ends with the serial, "1A2B-3C4D", whatever the language of the surrounding text is.
String? parseVolumeSerial(String output) {
  final m = RegExp(r'\b([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})\s*$', multiLine: true).allMatches(output).lastOrNull;
  return m?.group(1);
}

/// Reads the two values from Windows. Returns null when either cannot be read (not Windows, no permission).
Future<String?> readMachineId({String drive = 'C:'}) async {
  if (!Platform.isWindows) return null;
  try {
    final reg = await Process.run('reg', [r'query', r'HKLM\SOFTWARE\Microsoft\Cryptography', '/v', 'MachineGuid']);
    final vol = await Process.run('cmd', ['/c', 'vol', drive]);
    final guid = parseMachineGuid('${reg.stdout}');
    final serial = parseVolumeSerial('${vol.stdout}');
    if (guid == null || serial == null) return null;
    return machineIdFrom(guid: guid, volumeSerial: serial);
  } catch (_) {
    return null;
  }
}
