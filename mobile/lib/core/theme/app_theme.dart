import 'package:flutter/material.dart';

/// CoCoffee palette, mirrored from the Web Admin (views/layout.ejs Tailwind theme: navy primary, amber CTA,
/// "xám sữa" milk greys) and docs/design-tokens.json (status colours, Zalo channel).
abstract final class Palette {
  // Navy (primary, sidebar, active marks)
  static const navyDarker = Color(0xFF0F172A); // sidebar background
  static const navyDark = Color(0xFF172554);
  static const navy = Color(0xFF1E3A8A);
  static const navyAccent = Color(0xFF1D4ED8); // links, focus, active outline
  static const navyLine = Color(0xFF1E293B);
  static const navyMuted = Color(0xFF94A3B8);
  static const navySoft = Color(0xFFCBD5E1);
  // Amber CTA
  static const amber = Color(0xFFFBBF24);
  static const amberPressed = Color(0xFFF59E0B);
  static const ink900 = Color(0xFF1B1D1F);
  // Milk greys (page background, quiet surfaces)
  static const milk50 = Color(0xFFFAF8F5);
  static const milk100 = Color(0xFFF4F1EC);
  static const milk200 = Color(0xFFE8E3DA);
  static const milk300 = Color(0xFFD6CFC3);
  static const milk500 = Color(0xFF8C8478);
  // Status (light / dark from design-tokens.json + Tailwind emerald/amber/red used by the web badges)
  static const good = Color(0xFF047857);
  static const goodTint = Color(0xFFD1FAE5);
  static const warn = Color(0xFFB45309);
  static const warnTint = Color(0xFFFEF3C7);
  static const bad = Color(0xFFB91C1C);
  static const badTint = Color(0xFFFEE2E2);
  static const info = Color(0xFF1D4ED8);
  static const infoTint = Color(0xFFDBEAFE);
  static const zalo = Color(0xFF0057D9);
  static const zaloTint = Color(0xFFD9E8FF);
}

/// Colours Material's ColorScheme has no slot for: status badges, the dark sidebar, chart marks.
@immutable
class CoColors extends ThemeExtension<CoColors> {
  const CoColors({
    required this.good,
    required this.goodTint,
    required this.warn,
    required this.warnTint,
    required this.bad,
    required this.badTint,
    required this.info,
    required this.infoTint,
    required this.neutral,
    required this.neutralTint,
    required this.zalo,
    required this.zaloTint,
    required this.sidebar,
    required this.sidebarText,
    required this.sidebarMuted,
    required this.muted,
    required this.line,
    required this.cta,
    required this.onCta,
  });

  final Color good, goodTint, warn, warnTint, bad, badTint, info, infoTint, neutral, neutralTint, zalo, zaloTint;
  final Color sidebar, sidebarText, sidebarMuted, muted, line, cta, onCta;

  static const light = CoColors(
    good: Palette.good, goodTint: Palette.goodTint,
    warn: Palette.warn, warnTint: Palette.warnTint,
    bad: Palette.bad, badTint: Palette.badTint,
    info: Palette.info, infoTint: Palette.infoTint,
    neutral: Color(0xFF5F666D), neutralTint: Palette.milk100,
    zalo: Palette.zalo, zaloTint: Palette.zaloTint,
    sidebar: Palette.navyDarker, sidebarText: Palette.navySoft, sidebarMuted: Palette.navyMuted,
    muted: Palette.milk500, line: Palette.milk200,
    cta: Palette.amber, onCta: Palette.ink900,
  );

  static const dark = CoColors(
    good: Color(0xFF8DB36B), goodTint: Color(0xFF24331F),
    warn: Color(0xFFF2A33A), warnTint: Color(0xFF3A2C14),
    bad: Color(0xFFEE6C59), badTint: Color(0xFF3D1F1B),
    info: Color(0xFF60A5FA), infoTint: Color(0xFF1A2B45),
    neutral: Color(0xFFB9BEC3), neutralTint: Color(0xFF2F3337),
    zalo: Color(0xFF4C9AFF), zaloTint: Color(0xFF1A2B45),
    sidebar: Color(0xFF0B1120), sidebarText: Palette.navySoft, sidebarMuted: Palette.navyMuted,
    muted: Color(0xFF8A9097), line: Color(0xFF3D4247),
    cta: Palette.amber, onCta: Palette.ink900,
  );

  @override
  CoColors copyWith() => this;

  @override
  CoColors lerp(ThemeExtension<CoColors>? other, double t) => t < 0.5 ? this : (other as CoColors? ?? this);
}

extension CoTheme on BuildContext {
  CoColors get co => Theme.of(this).extension<CoColors>()!;
  ColorScheme get cs => Theme.of(this).colorScheme;
  TextTheme get tt => Theme.of(this).textTheme;
}

/// Serif like the web (Times New Roman there; Android's serif is Noto Serif, which has every Vietnamese glyph).
/// Numbers use tabular figures so money columns line up.
const kSerif = 'serif';
const tabular = [FontFeature.tabularFigures()];

ThemeData buildTheme(Brightness brightness) {
  final light = brightness == Brightness.light;
  final scheme = light
      ? const ColorScheme(
          brightness: Brightness.light,
          primary: Palette.navy,
          onPrimary: Colors.white,
          primaryContainer: Palette.infoTint,
          onPrimaryContainer: Palette.navyDarker,
          secondary: Palette.amber,
          onSecondary: Palette.ink900,
          secondaryContainer: Palette.warnTint,
          onSecondaryContainer: Palette.ink900,
          tertiary: Palette.zalo,
          onTertiary: Colors.white,
          error: Palette.bad,
          onError: Colors.white,
          surface: Colors.white,
          onSurface: Color(0xFF1F2123),
          onSurfaceVariant: Color(0xFF4A5056),
          surfaceContainerLowest: Colors.white,
          surfaceContainerLow: Palette.milk50,
          surfaceContainer: Palette.milk100,
          surfaceContainerHigh: Palette.milk200,
          surfaceContainerHighest: Palette.milk300,
          outline: Palette.milk300,
          outlineVariant: Palette.milk200,
        )
      : const ColorScheme(
          brightness: Brightness.dark,
          primary: Color(0xFF93C5FD),
          onPrimary: Palette.navyDarker,
          primaryContainer: Palette.navy,
          onPrimaryContainer: Colors.white,
          secondary: Palette.amber,
          onSecondary: Palette.ink900,
          secondaryContainer: Color(0xFF3A2C14),
          onSecondaryContainer: Color(0xFFF4F1EA),
          tertiary: Color(0xFF4C9AFF),
          onTertiary: Color(0xFF0B1B33),
          error: Color(0xFFEE6C59),
          onError: Color(0xFF1B1D1F),
          surface: Color(0xFF25282B),
          onSurface: Color(0xFFF4F1EA),
          onSurfaceVariant: Color(0xFFB9BEC3),
          surfaceContainerLowest: Color(0xFF1B1D1F),
          surfaceContainerLow: Color(0xFF1F2224),
          surfaceContainer: Color(0xFF25282B),
          surfaceContainerHigh: Color(0xFF2F3337),
          surfaceContainerHighest: Color(0xFF3D4247),
          outline: Color(0xFF6B737A),
          outlineVariant: Color(0xFF3D4247),
        );
  final co = light ? CoColors.light : CoColors.dark;
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, fontFamily: kSerif);
  final text = base.textTheme.apply(fontFamily: kSerif, bodyColor: scheme.onSurface, displayColor: scheme.onSurface);
  final page = light ? Palette.milk100 : const Color(0xFF1B1D1F);
  final radius = BorderRadius.circular(12);

  return base.copyWith(
    scaffoldBackgroundColor: page,
    extensions: [co],
    textTheme: text.copyWith(
      titleLarge: text.titleLarge?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -0.2),
      titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      bodyMedium: text.bodyMedium?.copyWith(fontSize: 15, height: 1.45),
      bodySmall: text.bodySmall?.copyWith(color: co.muted, fontSize: 12.5),
      labelSmall: text.labelSmall?.copyWith(letterSpacing: 0.6, fontWeight: FontWeight.w600, color: co.muted),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: light ? Colors.white : const Color(0xFF25282B),
      foregroundColor: scheme.onSurface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w600, fontSize: 19),
    ),
    cardTheme: CardThemeData(
      color: scheme.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: co.line)),
    ),
    dividerTheme: DividerThemeData(color: co.line, space: 1, thickness: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: co.cta,
        foregroundColor: co.onCta,
        minimumSize: const Size(64, 46),
        textStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w700, fontSize: 15),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: scheme.onSurface,
        minimumSize: const Size(64, 46),
        side: BorderSide(color: scheme.outline),
        textStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w600, fontSize: 15),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: light ? Palette.navyAccent : scheme.primary),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surface,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: scheme.outline)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: scheme.outline)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Palette.navyAccent, width: 1.5)),
    ),
    chipTheme: base.chipTheme.copyWith(
      shape: const StadiumBorder(),
      side: BorderSide(color: co.line),
      labelStyle: const TextStyle(fontFamily: kSerif, fontWeight: FontWeight.w500),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: light ? Palette.navyDarker : const Color(0xFF0B1120),
      indicatorColor: Colors.transparent,
      height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(
            fontFamily: kSerif,
            fontSize: 12.5,
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
            color: s.contains(WidgetState.selected) ? Colors.white : Palette.navyMuted,
          )),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(
            color: s.contains(WidgetState.selected) ? Palette.amber : Palette.navyMuted,
            size: 24,
          )),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: scheme.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    ),
    dialogTheme: DialogThemeData(backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: radius)),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Palette.navyDarker,
      contentTextStyle: const TextStyle(fontFamily: kSerif, color: Colors.white, fontSize: 15),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
    listTileTheme: ListTileThemeData(iconColor: co.muted, contentPadding: const EdgeInsets.symmetric(horizontal: 16)),
  );
}
