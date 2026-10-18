"""
PNG brand files of the web site and the Flutter apps, drawn from the same shapes as the app icon (branding/make-app-icon.py).

  python branding/make-web-brand.py

  public/brand/mark.png            logo + cup + "POS", transparent, ~square (header, sidebar, POS, login, download pages)
  public/brand/logo.png            full lockup: mark, TASOTEK (red), "FnB  POS" (transparent)
  public/brand/favicon-32.png, icon-192.png, apple-touch-icon.png, public/favicon.ico    from the app icon
  mobile/assets/brand/mark.png, logo.png    bundled in the phone app (no network needed for the logo)
  desktop/assets/brand/mark.png, license_manager/assets/brand/mark.png
"""
import importlib.util
import os
import shutil

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('icon', os.path.join(ROOT, 'branding', 'make-app-icon.py'))
icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon)

FONT = next(f for f in (r'C:\Windows\Fonts\seguibl.ttf', r'C:\Windows\Fonts\ariblk.ttf', r'C:\Windows\Fonts\arialbd.ttf') if os.path.exists(f))
RED, INK = (212, 38, 52), (22, 39, 95)


def trimmed(im, pad=0.0):
    box = im.getbbox()
    im = im.crop(box)
    p = round(max(im.size) * pad)
    out = Image.new('RGBA', (im.width + 2 * p, im.height + 2 * p), (0, 0, 0, 0))
    out.paste(im, (p, p))
    return out


def mark_with_label(label='POS'):
    icon.LABEL = label
    big = icon.compose(2048, 0.9, background=False)
    return trimmed(big, 0.02)


def spaced_text(draw, text, font, cx, baseline, spacing, fill):
    widths = [font.getlength(c) for c in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = cx - total / 2
    for c, w in zip(text, widths):
        draw.text((x, baseline), c, font=font, fill=fill, anchor='ls')
        x += w + spacing


def lockup():
    """Mark (without the POS label), TASOTEK in red and 'FnB  POS' in navy; 1000 x 800 design grid, drawn at 2x."""
    k = 2.0
    icon.LABEL = ''
    mk = trimmed(icon.compose(2048, 0.9, background=False))
    scale = (744 * k) / mk.width
    mk = mk.resize((round(mk.width * scale), round(mk.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', (round(1000 * k), round(800 * k)), (0, 0, 0, 0))
    canvas.paste(mk, (round(500 * k - mk.width / 2), round(55 * k)), mk)
    d = ImageDraw.Draw(canvas)
    spaced_text(d, 'TASOTEK', ImageFont.truetype(FONT, round(150 * k)), 500 * k, 665 * k, 6 * k, RED)
    spaced_text(d, 'FNB  POS'.replace('FNB', 'FnB'), ImageFont.truetype(FONT, round(82 * k)), 500 * k, 770 * k, 14 * k, INK)
    icon.LABEL = 'POS'
    return trimmed(canvas, 0.02)


def save(im, path, size=None, width=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    elif size:
        im = im.resize(size, Image.LANCZOS)
    im.save(path, optimize=True)
    return im


def main():
    brand = os.path.join(ROOT, 'public', 'brand')
    mark = save(mark_with_label('POS'), os.path.join(brand, 'mark.png'), width=512)
    logo = save(lockup(), os.path.join(brand, 'logo.png'), width=960)
    master = Image.open(os.path.join(ROOT, 'branding', 'app-icon-1024.png')).convert('RGB')
    master.resize((180, 180), Image.LANCZOS).save(os.path.join(brand, 'apple-touch-icon.png'), optimize=True)
    master.resize((192, 192), Image.LANCZOS).save(os.path.join(brand, 'icon-192.png'), optimize=True)
    master.resize((32, 32), Image.LANCZOS).save(os.path.join(brand, 'favicon-32.png'), optimize=True)
    master.convert('RGBA').save(os.path.join(ROOT, 'public', 'favicon.ico'), format='ICO', sizes=[(64, 64), (32, 32), (16, 16)])
    for app in ('mobile', 'desktop', 'license_manager'):
        d = os.path.join(ROOT, app, 'assets', 'brand')
        os.makedirs(d, exist_ok=True)
        if app == 'license_manager':
            icon.LABEL = 'KEY'
            save(trimmed(icon.compose(2048, 0.9, background=False), 0.02), os.path.join(d, 'mark.png'), width=512)
            icon.LABEL = 'POS'
        else:
            shutil.copy(os.path.join(brand, 'mark.png'), os.path.join(d, 'mark.png'))
    shutil.copy(os.path.join(brand, 'logo.png'), os.path.join(ROOT, 'mobile', 'assets', 'brand', 'logo.png'))
    print('mark', mark.size, 'logo', logo.size)


if __name__ == '__main__':
    main()
