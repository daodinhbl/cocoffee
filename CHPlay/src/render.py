"""
Renders the Google Play store graphics of POS Tasotek (com.tasotek.fnb) into CHPlay/.

  python CHPlay/src/render.py          # everything
  python CHPlay/src/render.py invite   # only the testers' invite (QR codes + card)

Needs Google Chrome (headless screenshots of the HTML templates here) and Pillow; the fonts load from Google Fonts,
so the machine must be online. Every output is a 24-bit PNG (no alpha), as Play requires for the feature graphic and
screenshots.
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(SRC)
CHROME = next(p for p in (
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
) if os.path.exists(p))

PHONE = ['pos', 'dashboard', 'orders', 'tables', 'inventory', 'reports', 'customers', 'heli']
TABLET = ['pos', 'dashboard', 'orders', 'inventory', 'reports']


def shoot(page, key, w, h, dest):
    url = 'file:///' + os.path.join(SRC, page).replace('\\', '/') + (f'#{key}' if key else '')
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'shot.png')
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                        f'--user-data-dir={tmp}', f'--window-size={w},{h}', '--virtual-time-budget=15000',
                        f'--screenshot={raw}', url], check=True, capture_output=True)
        im = Image.open(raw).convert('RGB')
    assert im.size == (w, h), f'{dest}: got {im.size}, expected {(w, h)}'
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    im.save(dest, optimize=True)
    print(f'{os.path.relpath(dest, OUT)}  {w}x{h}  {os.path.getsize(dest) // 1024} KB')


def icon():
    """Play icon: 512 x 512, from the launcher artwork (branding/make-app-icon.py). Play rounds the corners itself."""
    dest = os.path.join(OUT, 'icon', 'icon-512.png')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    Image.open(os.path.join(SRC, 'assets', 'app-icon-1024.png')).convert('RGB').resize((512, 512), Image.LANCZOS).save(dest, optimize=True)
    print(f'icon/icon-512.png  512x512  {os.path.getsize(dest) // 1024} KB')


def invite():
    """Testers' invite: the two QR codes (make-qr.js) and a 4:5 card to share on Zalo / Facebook."""
    subprocess.run(['node', os.path.join(SRC, 'make-qr.js')], check=True)
    shoot('invite.html', None, 1080, 1350, os.path.join(OUT, 'invite', 'thiep-moi-thu-nghiem.png'))


if __name__ == '__main__':
    if sys.argv[1:] == ['invite']:      # python CHPlay/src/render.py invite  -> only the invite files
        invite()
        sys.exit()
    icon()
    invite()
    shoot('feature.html', None, 1024, 500, os.path.join(OUT, 'feature-graphic', 'feature-graphic-1024x500.png'))
    for i, k in enumerate(PHONE, 1):
        shoot('phone.html', k, 1080, 1920, os.path.join(OUT, 'phone', f'{i:02d}-{k}.png'))
    for i, k in enumerate(TABLET, 1):
        shoot('tablet.html', k, 1920, 1080, os.path.join(OUT, 'tablet', f'{i:02d}-{k}.png'))
    shutil.rmtree(os.path.join(SRC, '__pycache__'), ignore_errors=True)
