"""
Builds the launcher icon of the Flutter app "Tasotek FnB" (mobile/) from the real Tasotek logo: the navy rounded frame with the T and the red roof.
The logo (mark with the gold F&B cup standing on the T, and "POS" under it) is redrawn here as vector shapes, so every size is crisp.

  python branding/make-app-icon.py      # iOS + Android icons, branding/app-icon-1024.png, branding/app-icon-preview.png

iOS: 1024 px, no transparency (Apple rounds the corners itself).
Android: adaptive icon (foreground + white background + monochrome layer for themed icons) and legacy square/round PNGs per density.
Art coordinates: the logo's own grid, x 8..752, y 45..470.
"""
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IOS_DIR = os.path.join(ROOT, 'mobile', 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset')
RES = os.path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res')

BG = (255, 255, 255)
NAVY, RED, GOLD = (31, 71, 150), (212, 38, 52), (240, 160, 40)
SS = 4                                                                    # supersampling
LABEL = 'POS'                                                             # the word under the logo (the licensing app uses 'KEY')
ART_W, ART_H, ART_CX, ART_CY = 744.0, 635.0, 380.0, 362.5       # the whole group: logo on top, the F&B cup below it


def shapes(scale, ox, oy, size):
    """Returns three 'L' masks (size x size): navy parts (logo frame, bar, stem, foot + the cup), the red roof, and the gold steam."""
    S = size * SS
    P = lambda x, y: ((x * scale + ox) * SS, (y * scale + oy) * SS)
    k = scale * SS
    navy = Image.new('L', (S, S), 0)
    red = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(navy)
    # frame: rounded rectangle outline
    d.rounded_rectangle([*P(8, 45), *P(752, 470)], radius=105 * k, fill=255)
    d2 = Image.new('L', (S, S), 0)
    ImageDraw.Draw(d2).rounded_rectangle([*P(46, 83), *P(714, 432)], radius=70 * k, fill=255)
    navy = ImageChops.subtract(navy, d2)
    d = ImageDraw.Draw(navy)
    # the T: a bar across from the left edge with a slanted right end, a stem down to the bottom edge, and the foot block
    d.polygon([P(20, 228), P(512, 228), P(548, 272), P(20, 278)], fill=255)
    d.polygon([P(190, 270), P(288, 270), P(252, 445), P(160, 445)], fill=255)
    d.polygon([P(330, 270), P(447, 270), P(432, 378), P(322, 378)], fill=255)
    # the red roof
    ImageDraw.Draw(red).polygon([P(366, 110), P(520, 108), P(736, 352), P(714, 408), P(458, 172), P(444, 200), P(360, 200)], fill=255)
    # the F&B cup stands on the T's bar (gold, with steam); "POS" in bold navy under the frame
    gold = Image.new('L', (S, S), 0)
    Q = lambda x, y: P(228 + x * 0.5, 155.5 + y * 0.5)                  # cup grid -> art grid (same as the SVG logo: scale 0.5 at 228,155.5)
    g = ImageDraw.Draw(gold)
    g.polygon([Q(-88, 0), Q(88, 0), Q(72, 115), Q(20, 145), Q(-20, 145), Q(-72, 115)], fill=255)
    g.rounded_rectangle([*Q(-88, 0), *Q(88, 17)], radius=4 * k, fill=255)
    ring = Image.new('L', (S, S), 0)
    ImageDraw.Draw(ring).ellipse([*Q(62, 4), *Q(134, 76)], fill=255)
    hole = Image.new('L', (S, S), 0)
    ImageDraw.Draw(hole).ellipse([*Q(84, 26), *Q(112, 54)], fill=255)
    gold = ImageChops.lighter(gold, ImageChops.subtract(ring, hole))
    g = ImageDraw.Draw(gold)
    for sx in (-40, 0, 40):
        for i in range(29):
            x, y = sx + 8 * math.sin(i / 28 * 2 * math.pi + 0.3), -100 + i * 2.7
            px, py = Q(x, y)
            r = 4.5 * k
            g.ellipse([px - r, py - r, px + r, py + r], fill=255)
    font_file = next((f for f in (r'C:\Windows\Fonts\seguibl.ttf', r'C:\Windows\Fontsriblk.ttf', r'C:\Windows\Fontsrialbd.ttf') if os.path.exists(f)), None)
    font = ImageFont.truetype(font_file, round(215 * k))
    tx, ty = P(380, 680)
    ImageDraw.Draw(navy).text((tx, ty), LABEL, font=font, fill=255, anchor='ms')
    down = lambda m: m.resize((size, size), Image.LANCZOS)
    return down(navy), down(red), down(gold)


def compose(size, frac, background=True, mono=False):
    """frac: the logo's width as a fraction of the canvas width; it is centred on its bounding box."""
    scale = size * frac / ART_W
    navy, red, gold = shapes(scale, size / 2 - ART_CX * scale, size / 2 - ART_CY * scale, size)
    if mono:
        solid = ImageChops.lighter(ImageChops.lighter(navy, red), gold)
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        out.paste(Image.new('RGBA', (size, size), (0, 0, 0, 255)), (0, 0), solid)
        return out
    out = Image.new('RGBA', (size, size), BG + (255,)) if background else Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(Image.new('RGBA', (size, size), NAVY + (255,)), (0, 0), navy)
    out.paste(Image.new('RGBA', (size, size), RED + (255,)), (0, 0), red)
    out.paste(Image.new('RGBA', (size, size), GOLD + (255,)), (0, 0), gold)
    return out


def rounded(im, r):
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.width - 1, im.height - 1], r, fill=255)
    out = Image.new('RGBA', im.size, (0, 0, 0, 0))
    out.paste(im.convert('RGBA'), (0, 0), m)
    return out


def write_ico(path, master):
    master.convert('RGBA').save(path, format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])


def other_apps():
    """The Windows manager (POS) and the licensing app (KEY): .ico for Windows, AppIcon set for the licensing app's iOS build."""
    global LABEL
    write_ico(os.path.join(ROOT, 'desktop', 'windows', 'runner', 'resources', 'app_icon.ico'), compose(256, 0.80).convert('RGB'))
    LABEL = 'KEY'
    lm = compose(1024, 0.80).convert('RGB')
    write_ico(os.path.join(ROOT, 'license_manager', 'windows', 'runner', 'resources', 'app_icon.ico'), compose(256, 0.80).convert('RGB'))
    lm_ios = os.path.join(ROOT, 'license_manager', 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset')
    for f in os.listdir(lm_ios):
        if f.startswith('Icon-App-') and f.endswith('.png'):
            base, _, sc = f[len('Icon-App-'):-4].partition('@')
            px = round(float(base.split('x')[0]) * int(sc[:-1]))
            lm.resize((px, px), Image.LANCZOS).save(os.path.join(lm_ios, f), optimize=True)
    lm.save(os.path.join(ROOT, 'branding', 'app-icon-license-1024.png'))
    LABEL = 'POS'


def main():
    other_apps()
    master = compose(1024, 0.80).convert('RGB')
    n = 0
    for f in os.listdir(IOS_DIR):
        if f.startswith('Icon-App-') and f.endswith('.png'):
            base, _, scale = f[len('Icon-App-'):-4].partition('@')
            px = round(float(base.split('x')[0]) * int(scale[:-1]))
            master.resize((px, px), Image.LANCZOS).save(os.path.join(IOS_DIR, f), optimize=True)
            n += 1
    for d, k in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
        out = os.path.join(RES, f'mipmap-{d}')
        full = round(108 * k)
        compose(full, 0.54, background=False).save(os.path.join(out, 'ic_launcher_foreground.png'), optimize=True)        # inside the 66 dp safe circle
        compose(full, 0.54, background=False, mono=True).save(os.path.join(out, 'ic_launcher_monochrome.png'), optimize=True)
        legacy = round(48 * k)
        sq = compose(legacy, 0.80)
        sq.save(os.path.join(out, 'ic_launcher.png'), optimize=True)
        circle = Image.new('L', (legacy * 4, legacy * 4), 0)
        ImageDraw.Draw(circle).ellipse([0, 0, legacy * 4 - 1, legacy * 4 - 1], fill=255)
        rd = sq.copy()
        rd.putalpha(circle.resize((legacy, legacy), Image.LANCZOS))
        rd.save(os.path.join(out, 'ic_launcher_round.png'), optimize=True)
    anydpi = os.path.join(RES, 'mipmap-anydpi-v26')
    os.makedirs(anydpi, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@color/ic_launcher_background"/>\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
           '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n')
    for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        open(os.path.join(anydpi, name), 'w', encoding='utf8', newline='\n').write(xml)
    open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w', encoding='utf8', newline='\n').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n')

    # preview: iOS, Android circle / squircle (adaptive), a dark-wallpaper mono, small sizes
    sheet = Image.new('RGB', (1560, 560), (214, 218, 228))
    big = master.resize((400, 400), Image.LANCZOS)
    r = rounded(big, 90)
    sheet.paste(r, (30, 30), r)
    fg = compose(432, 0.54, background=False)
    adaptive = Image.alpha_composite(Image.new('RGBA', (432, 432), (255, 255, 255, 255)), fg)
    circle = Image.new('L', (432, 432), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, 431, 431], fill=255)
    sheet.paste(adaptive.resize((300, 300), Image.LANCZOS), (470, 30), circle.resize((300, 300), Image.LANCZOS))
    sq = rounded(adaptive.resize((300, 300), Image.LANCZOS), 70)
    sheet.paste(sq, (800, 30), sq)
    mono = compose(432, 0.54, background=False, mono=True)
    tile = Image.new('RGBA', (432, 432), (200, 210, 235, 255))
    tile = Image.alpha_composite(tile, Image.merge('RGBA', (*[mono.split()[3].point(lambda v: 255 - v * 0.8 // 1)] * 3, Image.new('L', (432, 432), 255))).resize((432, 432)))
    m2 = rounded(tile.resize((300, 300), Image.LANCZOS), 150)
    sheet.paste(m2, (1130, 30), m2)
    x = 470
    for px in (96, 64, 48, 32, 24):
        t = rounded(master.resize((px, px), Image.LANCZOS), round(px * 0.22))
        sheet.paste(t, (x, 380), t)
        x += px + 24
    sheet.save(os.path.join(ROOT, 'branding', 'app-icon-preview.png'))
    master.save(os.path.join(ROOT, 'branding', 'app-icon-1024.png'))
    print('ok', n, 'iOS sizes')


if __name__ == '__main__':
    sys.exit(main())
