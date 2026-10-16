/// idle -> listening -> thinking -> speaking -> idle; error when a step failed (the next action leaves it).
enum HeliPhase { idle, listening, thinking, speaking, error }

enum MicStatus { granted, denied, permanentlyDenied }

class HeliMessage {
  const HeliMessage({required this.fromUser, required this.text});
  final bool fromUser;
  final String text;
}

class HeliState {
  const HeliState({
    this.phase = HeliPhase.idle,
    this.messages = const [],
    this.handsFree = false,
    this.heard = '',
    this.error,
    this.errorSeq = 0,
    this.micIssue = false,
    this.followUpUntil,
  });

  final HeliPhase phase;
  final List<HeliMessage> messages;

  /// "Gọi Heli" switch: listening continuously while the screen is open.
  final bool handsFree;

  /// Partial text while the user is speaking.
  final String heard;

  /// Last error, in Vietnamese. [errorSeq] changes for every new one so the screen can toast each time.
  final String? error;
  final int errorSeq;

  /// The microphone permission was refused for good: the screen offers the app settings.
  final bool micIssue;

  /// End of the 20 second window in which a question needs no "Heli".
  final DateTime? followUpUntil;

  HeliState copyWith({
    HeliPhase? phase,
    List<HeliMessage>? messages,
    bool? handsFree,
    String? heard,
    Object? error = _keep,
    int? errorSeq,
    bool? micIssue,
    Object? followUpUntil = _keep,
  }) =>
      HeliState(
        phase: phase ?? this.phase,
        messages: messages ?? this.messages,
        handsFree: handsFree ?? this.handsFree,
        heard: heard ?? this.heard,
        error: identical(error, _keep) ? this.error : error as String?,
        errorSeq: errorSeq ?? this.errorSeq,
        micIssue: micIssue ?? this.micIssue,
        followUpUntil: identical(followUpUntil, _keep) ? this.followUpUntil : followUpUntil as DateTime?,
      );

  static const _keep = Object();

  bool get busy => phase == HeliPhase.thinking || phase == HeliPhase.speaking;

  /// The line under the title.
  String get statusText {
    switch (phase) {
      case HeliPhase.listening:
        return handsFree && heard.isEmpty ? 'Đang chờ gọi Heli…' : 'Heli đang nghe…';
      case HeliPhase.thinking:
        return 'Đang xử lý…';
      case HeliPhase.speaking:
        return 'Đang trả lời…';
      case HeliPhase.error:
        return error ?? 'Có lỗi xảy ra.';
      case HeliPhase.idle:
        return handsFree ? 'Đang chờ gọi Heli…' : 'Nhấn micro để nói với Heli';
    }
  }
}
