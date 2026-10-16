/// How long after Heli's answer a follow-up needs no "Heli" again.
const kHeliFollowUp = Duration(seconds: 20);

const _groups = {
  'a': 'àáảãạăằắẳẵặâầấẩẫậ',
  'e': 'èéẻẽẹêềếểễệ',
  'i': 'ìíỉĩị',
  'o': 'òóỏõọôồốổỗộơờớởỡợ',
  'u': 'ùúủũụưừứửữự',
  'y': 'ỳýỷỹỵ',
  'd': 'đ',
};

final _fold = <int, String>{
  for (final g in _groups.entries)
    for (final r in g.value.runes) r: g.key,
};

/// Lower-case without Vietnamese marks. Every character maps to exactly one character, so an index in the result
/// is the same index in [text] (the command is cut from the original wording).
String foldVietnamese(String text) {
  final b = StringBuffer();
  for (final r in text.toLowerCase().runes) {
    b.write(_fold[r] ?? String.fromCharCode(r));
  }
  return b.toString();
}

// "Heli" as speech recognition tends to hear it: heli, hê li, hey li, hi li, e li, helly.
final _wake = RegExp(r'(?<![a-z])(?:heli|helly|he\s?li|hey\s?li|hi\s?li|e\s?li)(?![a-z])');
final _lead = RegExp(r'^[\s,.;:!?\-]+');

class WakeMatch {
  const WakeMatch(this.command);

  /// What was said besides the name (may be empty: the user only called "Heli").
  final String command;
}

/// null = the name "Heli" was not heard.
WakeMatch? matchWake(String text) {
  final folded = foldVietnamese(text);
  if (folded.length != text.length) return null; // exotic characters changed the length: do not guess
  final m = _wake.firstMatch(folded);
  if (m == null) return null;
  final after = text.substring(m.end).replaceFirst(_lead, '').trim();
  if (after.isNotEmpty) return WakeMatch(after);
  return WakeMatch(text.substring(0, m.start).replaceFirst(_lead, '').trim());
}

/// What to do with a finished phrase heard in hands-free mode.
sealed class WakeDecision {
  const WakeDecision();
}

/// Not for Heli: drop it, send nothing.
class WakeIgnore extends WakeDecision {
  const WakeIgnore();
}

/// Only the name: "ting" and wait for the command.
class WakeCalled extends WakeDecision {
  const WakeCalled();
}

class WakeCommand extends WakeDecision {
  const WakeCommand(this.text);
  final String text;
}

/// [activeUntil] is the end of the follow-up window (null = closed).
WakeDecision decideWake(String heard, {required DateTime now, DateTime? activeUntil}) {
  final text = heard.trim();
  if (text.isEmpty) return const WakeIgnore();
  final wake = matchWake(text);
  final open = activeUntil != null && now.isBefore(activeUntil);
  if (wake == null) return open ? WakeCommand(text) : const WakeIgnore();
  return wake.command.isEmpty ? const WakeCalled() : WakeCommand(wake.command);
}
