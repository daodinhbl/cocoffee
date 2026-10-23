import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// The frame of the first-run screens, styled like the login page: navy background, brand mark, white card.
class OnboardingFrame extends StatelessWidget {
  const OnboardingFrame({super.key, required this.title, this.subtitle, required this.child, this.onBack, this.maxWidth = 460});

  final String title;
  final String? subtitle;
  final Widget child;

  /// Shows "Quay lại" above the card.
  final VoidCallback? onBack;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Palette.navyDarker,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (onBack != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: onBack,
                      icon: const Icon(Icons.arrow_back_rounded, size: 18, color: Palette.navySoft),
                      label: const Text('Quay lại', style: TextStyle(color: Palette.navySoft)),
                    ),
                  ),
                Center(
                  child: Container(
                    width: 64,
                    height: 64,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
                    child: Image.asset('assets/brand/mark.png'),
                  ),
                ),
                const SizedBox(height: 12),
                Text(title, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700)),
                if (subtitle != null) ...[
                  const SizedBox(height: 4),
                  Text(subtitle!, textAlign: TextAlign.center, style: const TextStyle(color: Palette.navyMuted, fontSize: 15)),
                ],
                const SizedBox(height: 20),
                child,
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Label above a form field, like the login page.
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key, this.hint});
  final String text;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(text, style: const TextStyle(fontWeight: FontWeight.w600)),
        if (hint != null) Text(hint!, style: context.tt.bodySmall?.copyWith(color: context.co.muted)),
      ]),
    );
  }
}

/// Red box with an error message at the top of a form.
class FormNotice extends StatelessWidget {
  const FormNotice(this.text, {super.key, this.good = false});
  final String text;
  final bool good;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: good ? context.co.goodTint : context.co.badTint, borderRadius: BorderRadius.circular(10)),
      child: Text(text, style: TextStyle(color: good ? context.co.good : context.co.bad)),
    );
  }
}

/// Section heading inside a form card.
class FormHeading extends StatelessWidget {
  const FormHeading(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Text(text, style: context.tt.titleSmall?.copyWith(color: context.cs.primary, fontWeight: FontWeight.w700)),
      );
}

/// Same rules as the server (tenantService.js USER_RE).
final kUsernamePattern = RegExp(r'^[a-z0-9][a-z0-9._-]{2,29}$');

String? validateUsername(String? v) =>
    kUsernamePattern.hasMatch((v ?? '').trim().toLowerCase()) ? null : '3-30 ký tự: chữ thường không dấu, số, dấu chấm, gạch ngang hoặc gạch dưới.';
