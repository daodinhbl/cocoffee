import 'dart:typed_data';

/// ESC/POS bytes for a thermal printer from a picture of the receipt.
///
/// Vietnamese needs accents the printers' built-in code pages do not have, so the bill is drawn as an image on the phone
/// (receipt_image.dart) and sent as a raster bitmap: `GS v 0`. [rgba] is the picture as RGBA, 4 bytes per pixel;
/// [width] must be a multiple of 8 (384 dots = 58 mm, 576 dots = 80 mm). A pixel darker than [threshold] (0-255,
/// after alpha is flattened onto white) is printed black.
Uint8List escposRaster(Uint8List rgba, int width, int height, {int threshold = 160, bool cut = true, bool fullCut = false, int feedLines = 3}) {
  if (width <= 0 || width % 8 != 0) throw ArgumentError('width must be a positive multiple of 8, got $width');
  if (rgba.length != width * height * 4) throw ArgumentError('rgba has ${rgba.length} bytes, expected ${width * height * 4}');
  final bytesPerRow = width ~/ 8;
  final out = BytesBuilder(copy: false);
  out.add(const [0x1B, 0x40]); // ESC @ : reset
  // Chunks of at most 255 rows: some printers drop a taller raster block.
  for (var top = 0; top < height; top += 255) {
    final rows = height - top < 255 ? height - top : 255;
    out.add([0x1D, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, bytesPerRow >> 8, rows & 0xFF, rows >> 8]);
    final block = Uint8List(bytesPerRow * rows);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < width; x++) {
        final i = ((top + y) * width + x) * 4;
        final a = rgba[i + 3];
        // flatten alpha onto white, then luminance
        final r = (rgba[i] * a + 255 * (255 - a)) ~/ 255;
        final g = (rgba[i + 1] * a + 255 * (255 - a)) ~/ 255;
        final b = (rgba[i + 2] * a + 255 * (255 - a)) ~/ 255;
        final lum = (r * 299 + g * 587 + b * 114) ~/ 1000;
        if (lum < threshold) block[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    out.add(block);
  }
  out.add(List.filled(feedLines, 0x0A)); // line feeds so the text clears the cutter
  if (cut) out.add(fullCut ? const [0x1D, 0x56, 0x00] : const [0x1D, 0x56, 0x42, 0x00]); // GS V 0 : full cut; GS V 66 0 : feed and partial cut
  return out.toBytes();
}

/// How the receipt is printed (kept per phone, with the printer): ink [density], whether and how the paper is cut, and the lines fed
/// before the cut so the last line clears the blade. Defaults are what the app always sent.
class PrintOptions {
  const PrintOptions({this.density = 1, this.cut = kCutPartial, this.feedLines = 3});
  final int density;          // 0 light, 1 normal, 2 dark
  final String cut;           // kCutPartial | kCutFull | kCutNone
  final int feedLines;        // 0..8
  int get threshold => const [200, 160, 120][density.clamp(0, 2)];

  PrintOptions copyWith({int? density, String? cut, int? feedLines}) => PrintOptions(density: density ?? this.density, cut: cut ?? this.cut, feedLines: feedLines ?? this.feedLines);

  static PrintOptions from({int? density, String? cut, int? feedLines}) => PrintOptions(
        density: (density ?? 1).clamp(0, 2),
        cut: const [kCutPartial, kCutFull, kCutNone].contains(cut) ? cut! : kCutPartial,
        feedLines: (feedLines ?? 3).clamp(0, 8),
      );
}

const kCutPartial = 'partial';
const kCutFull = 'full';
const kCutNone = 'none';

/// Dots across for a paper width: 58 mm -> 384, 80 mm -> 576.
int dotsForPaper(int paperMm) => paperMm <= 58 ? 384 : 576;
