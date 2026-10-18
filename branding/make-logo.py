"""
Tasotek FnB logo as SVG, text converted to outlines (no font needed to open it).

  python branding/make-logo.py     ->  branding/logo-tasotek-fnb.svg          primary lockup (mark, TASOTEK, FnB POS with the cup)
                                       branding/logo-tasotek-fnb-horizontal.svg  mark on the left, words on the right
                                       branding/logo-tasotek-fnb-mono.svg        one colour (navy), for stamps / receipts

Elements: the Tasotek mark (navy rounded frame, T, red roof; traced from the shop's card, grid x 8..752 y 45..470) and the F&B symbol
(steaming cup on a saucer, gold steam). Colours: navy #1F4796, red #D42634, gold #F0A028.
"""
import math
import os

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.abspath(__file__))
FONT = next(f for f in (r'C:\Windows\Fonts\seguibl.ttf', r'C:\Windows\Fonts\ariblk.ttf', r'C:\Windows\Fonts\arialbd.ttf') if os.path.exists(f))
NAVY, RED, GOLD, INK = '#1F4796', '#D42634', '#F0A028', '#16275F'
_font = TTFont(FONT)
_gs = _font.getGlyphSet()
_cmap = _font.getBestCmap()
_upm = _font['head'].unitsPerEm


def text_path(text, size, x, y, anchor='start', spacing=0.0):
    """SVG path data of `text` (baseline at y). Returns (d, width)."""
    k = size / _upm
    adv = [_gs[_cmap[ord(c)]].width * k + spacing for c in text]
    width = sum(adv) - spacing
    cx = x - (width / 2 if anchor == 'middle' else width if anchor == 'end' else 0)
    pen = SVGPathPen(_gs, ntos=lambda v: f'{v:.1f}')
    for c, a in zip(text, adv):
        tp = TransformPen(pen, (k, 0, 0, -k, cx, y))
        _gs[_cmap[ord(c)]].draw(tp)
        cx += a
    return pen.getCommands(), width


def rrect(x0, y0, x1, y1, r):
    return (f'M{x0 + r},{y0}H{x1 - r}A{r},{r} 0 0 1 {x1},{y0 + r}V{y1 - r}A{r},{r} 0 0 1 {x1 - r},{y1}H{x0 + r}A{r},{r} 0 0 1 {x0},{y1 - r}'
            f'V{y0 + r}A{r},{r} 0 0 1 {x0 + r},{y0}Z')


def mark(navy=NAVY, red=RED, cup_fill=GOLD, steam=GOLD, cup_stroke=None):
    """The Tasotek mark in its own grid (x 8..752, y 45..470)."""
    return (
        f'<path fill="{navy}" fill-rule="evenodd" d="{rrect(8, 45, 752, 470, 105)} {rrect(46, 83, 714, 432, 70)}"/>'
        f'<path fill="{navy}" d="M20,228H512L548,272L20,278Z"/>'
        f'<path fill="{navy}" d="M190,270H288L252,445H160Z"/>'
        f'<path fill="{navy}" d="M330,270H447L432,378H322Z"/>'
        f'<path fill="{red}" d="M366,110L520,108L736,352L714,408L458,172L444,200L360,200Z"/>'
        # the F&B cup stands on the T's bar (bar top y=228): body bottom at 228, steam rises into the frame
        f'<g transform="translate(228 155.5) scale(0.5)">{cup(0, 0, navy=cup_fill, gold=steam, saucer=False, steam_w=18, stroke=cup_stroke)}</g>'
    )


def cup(cx, top, navy=NAVY, gold=GOLD, saucer=True, steam_w=12, stroke=None):
    """The F&B cup, 176 wide + handle (body from y=top to top+145, saucer to top+172); steam rises ~100 above `top`.
    `stroke` outlines the body (used in the one-colour version where the fill would vanish)."""
    t = top
    st = f' stroke="{stroke}" stroke-width="12" stroke-linejoin="round"' if stroke else ''
    parts = [
        f'<path fill="{navy}"{st} d="M{cx - 88},{t}H{cx + 88}L{cx + 72},{t + 115}L{cx + 20},{t + 145}H{cx - 20}L{cx - 72},{t + 115}Z"/>',
        f'<path fill="{navy}" fill-rule="evenodd"{st} d="M{cx + 62},{t + 40}a36,36 0 1 0 72,0a36,36 0 1 0 -72,0ZM{cx + 84},{t + 40}a14,14 0 1 0 28,0a14,14 0 1 0 -28,0Z"/>',
        f'<rect x="{cx - 88}" y="{t}" width="176" height="17" rx="8" fill="{navy}"{st}/>',
    ]
    if saucer:
        parts.append(f'<rect x="{cx - 118}" y="{t + 150}" width="236" height="22" rx="11" fill="{navy}"/>')
    for sx in (-40, 0, 40):
        pts = [(cx + sx + 8 * math.sin(i / 28 * 2 * math.pi + 0.3), t - 100 + i * 2.7) for i in range(29)]
        d = 'M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in pts)
        parts.append(f'<path d="{d}" fill="none" stroke="{gold}" stroke-width="{steam_w}" stroke-linecap="round" stroke-linejoin="round"/>')
    return ''.join(parts)


def svg(w, h, body, bg=None, title='Tasotek FnB'):
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{rect}{body}</svg>\n')


def stacked(navy, red, ink, gold, bg='#FFFFFF', mono=False):
    w, h = 1000, 800
    m = mark(navy, red, '#FFFFFF' if mono else GOLD, ink if mono else gold, ink if mono else None)
    body = f'<g transform="translate(128 10)">{m}</g>'                               # mark y 55..480
    d, _ = text_path('TASOTEK', 150, 500, 665, 'middle', spacing=6)
    body += f'<path fill="{red}" d="{d}"/>'
    d2, _ = text_path('FnB  POS', 82, 500, 770, 'middle', spacing=14)
    body += f'<path fill="{ink}" d="{d2}"/>'
    return svg(w, h, body, bg=bg)


def primary():
    return stacked(NAVY, RED, INK, GOLD)


def horizontal():
    w, h = 1500, 520
    body = f'<g transform="translate(24 22)">{mark()}</g>'
    d, _ = text_path('TASOTEK', 168, 810, 262, 'start', spacing=6)
    body += f'<path fill="{RED}" d="{d}"/>'
    d2, _ = text_path('FnB  POS', 84, 816, 392, 'start', spacing=14)
    body += f'<path fill="{INK}" d="{d2}"/>'
    return svg(w, h, body, bg='#FFFFFF')


def mono():
    return stacked(INK, INK, INK, INK, mono=True)


if __name__ == '__main__':
    for name, fn in (('logo-tasotek-fnb.svg', primary), ('logo-tasotek-fnb-horizontal.svg', horizontal), ('logo-tasotek-fnb-mono.svg', mono)):
        open(os.path.join(ROOT, name), 'w', encoding='utf8', newline='\n').write(fn())
        print('wrote', name)
