"""Render the Settings page as a PNG from the live snapshot (no browser needed).

The mock-up mirrors lib/client.js' PriceBoard/PriceTable markup and styling
(same labels, same order rules, same token colours resolved for light mode),
so the picture shows exactly what the plugin draws: plan chips, sort select,
per-plan summary line, rank column, "最便宜" tag and the vs-US ratio column.

usage: python make_screenshot.py <snapshot.json> <out.png>
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

SNAPSHOT = sys.argv[1]
OUT = sys.argv[2]

PLANS = ["go", "plus", "pro_100", "pro_200", "pro_500"]
PLAN_LABELS = {"go": "Go", "plus": "Plus", "pro_100": "Pro 100", "pro_200": "Pro 200", "pro_500": "Pro 500"}
DISPLAY = ["plus"]  # one plan selected, as the settings page starts

# --dsw-alias-* resolved for the light theme (Harness light surface values)
T = {
    "bg-base": "#ffffff",
    "bg-layer-1": "#f7f8fa",
    "bg-layer-2": "#f1f2f5",
    "border-l1": "#e4e6eb",
    "border-l2": "#d5d8de",
    "brand": "#4d6bfe",
    "label-primary": "#1f2329",
    "label-secondary": "#6b7280",
    "success": "#1f9254",
    "warn": "#b54708",
    "error": "#d92d20",
    "sidebar": "#f7f8fa",
}

FONT_DIR = "C:/Windows/Fonts/"
def font(size, bold=False):
    name = "msyhbd.ttc" if bold else "msyh.ttc"
    try:
        return ImageFont.truetype(FONT_DIR + name, size)
    except OSError:
        return ImageFont.truetype(FONT_DIR + ("arialbd.ttf" if bold else "arial.ttf"), size)

F = {
    "title": font(30, True),
    "body": font(19),
    "body_b": font(19, True),
    "small": font(16),
    "small_b": font(16, True),
    "cell": font(17),
    "cell_b": font(17, True),
    "badge": font(14, True),
}

with open(SNAPSHOT, encoding="utf-8") as handle:
    snap = json.load(handle)

regions = snap.get("regions", [])
prices = snap.get("prices", [])
by_key = {(p["region"], p["plan"]): p for p in prices}
order = {r["code"]: i for i, r in enumerate(regions)}
region_name = {r["code"]: r.get("name", r["code"]) for r in regions}

focus = "plus" if "plus" in DISPLAY else DISPLAY[0]
shown = [p for p in PLANS if p in DISPLAY]

def price_of(code, plan):
    return (by_key.get((code, plan)) or {}).get("cny")

def row_cny(code):
    return price_of(code, focus)

def row_ratio(code):
    value = row_cny(code)
    if value is None:
        return None
    usd = price_of("US", focus)
    return value / usd if usd else None

sort = "cheap"
rows = [r["code"] for r in regions if row_cny(r["code"]) is not None]
missing = [r["code"] for r in regions if row_cny(r["code"]) is None]
key = row_ratio if sort == "ratio" else (lambda c: row_cny(c))
rows.sort(key=lambda c: (key(c), order.get(c, 999)))
rows += missing

def per_plan(plan):
    values = [(price_of(r["code"], plan), r["code"]) for r in regions if price_of(r["code"], plan) is not None]
    return min(values), max(values)

low, high = per_plan(focus)
spread = round(high[0] / low[0], 2)
spread_text = f"{spread:.2f}×"
cheapest = low[0]
usd_cny = price_of("US", focus) or 0

def money(value):
    if value is None:
        return "—"
    return f"¥{value:,.1f}"

def fmt_date(iso):
    return iso.replace("-", "/")

# ---------------------------------------------------------------- layout
W = 1180
M = 28
HEAD_H = 108
line_h = 46
table_top = HEAD_H + 178
H = table_top + line_h * (len(rows) + 1) + 44

img = Image.new("RGB", (W, H), T["bg-base"])
d = ImageDraw.Draw(img)

# window chrome
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=14, fill=T["bg-base"], outline=T["border-l1"])
d.rectangle([0, 0, W - 1, 40], fill=T["sidebar"])
d.rounded_rectangle([0, 0, W - 1, 40], radius=14, fill=T["sidebar"])
d.rectangle([0, 26, W - 1, 40], fill=T["sidebar"])
for i, color in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
    d.ellipse([16 + i * 22, 13, 28 + i * 22, 25], fill=color)
d.text((96, 10), "设置 · Settings", font=F["small"], fill=T["label-secondary"])

y = 40 + 26

# title + status badge
d.text((M, y), "ChatGPT 各区价格", font=F["title"], fill=T["label-primary"])
badge_text = "未更新" if snap.get("status") == "empty" else ("部分更新" if snap.get("status") == "partial" else "已更新")
bw = d.textlength(badge_text, font=F["badge"]) + 22
bx = M + d.textlength("ChatGPT 各区价格", font=F["title"]) + 14
d.rounded_rectangle([bx, y + 6, bx + bw, y + 30], radius=12, fill="#e8f5ee")
d.text((bx + 11, y + 10), badge_text, font=F["badge"], fill=T["success"])

meta = f"数据日期 {fmt_date(snap.get('date', '—'))}   ·   {len(regions)} 个地区 · {len(prices)} 条价格   ·   ¥ 按 {snap.get('cnyPerUsd', 7.2)} CNY/USD 折算（OpenAI 官方汇率）"
d.text((M, y + 44), meta, font=F["small"], fill=T["label-secondary"])
y += 78

# plan chips row + sort select
chip_x = M
chip_label = "当前档位"
d.text((chip_x, y + 6), chip_label, font=F["small"], fill=T["label-secondary"])
chip_x += d.textlength(chip_label, font=F["small"]) + 12
for plan in PLANS:
    label = PLAN_LABELS[plan]
    on = plan in shown
    cw = d.textlength(label, font=F["small_b"]) + 22
    if on:
        d.rounded_rectangle([chip_x, y, chip_x + cw, y + 30], radius=15, fill=T["brand"])
    else:
        d.rounded_rectangle([chip_x, y, chip_x + cw, y + 30], radius=15, fill=T["bg-layer-1"], outline=T["border-l1"])
    d.text((chip_x + 11, y + 5), label, font=F["small_b"], fill="#ffffff" if on else T["label-secondary"])
    chip_x += cw + 8

sel_w = 150
sx = W - M - sel_w
d.text((sx - 62, y + 6), "排序", font=F["small"], fill=T["label-secondary"])
d.rounded_rectangle([sx, y, sx + sel_w, y + 30], radius=8, fill=T["bg-layer-1"], outline=T["border-l2"])
d.text((sx + 10, y + 5), "价格从低到高", font=F["small"], fill=T["label-primary"])
d.polygon([(sx + sel_w - 20, y + 13), (sx + sel_w - 12, y + 13), (sx + sel_w - 16, y + 19)], fill=T["label-secondary"])
y += 44

# summary line
summary = f"当前档位：{PLAN_LABELS[focus]}      最低 {region_name.get(low[1], low[1])} {money(low[0])}      最高 {region_name.get(high[1], high[1])} {money(high[0])}      价差：{spread_text}"
d.text((M, y), summary, font=F["body"], fill=T["label-primary"])
hint = f"2 个地区未在售   ·   相对美国 = 该区价格 ÷ 美国 {money(usd_cny)}"
d.text((M, y + 30), hint, font=F["small"], fill=T["label-secondary"])
y += 66

# table
cols = [("#", 52), ("地区", 190)] + [(PLAN_LABELS[p], 150) for p in shown] + [(f"相对美国 · {PLAN_LABELS[focus]}", 160)]
left = [M]
for _, w in cols:
    left.append(left[-1] + w)
right = W - M

d.rounded_rectangle([M, y, right, H - 20], radius=10, outline=T["border-l1"])
hy = y
d.rectangle([M, hy, right, hy + 40], fill=T["bg-layer-1"])
for i, (title, _) in enumerate(cols):
    tx = left[i] + 14
    if i >= 2:
        tx = left[i] + cols[i][1] - 14 - d.textlength(title, font=F["small_b"])
    d.text((tx, hy + 11), title, font=F["small_b"], fill=T["label-secondary"])
d.line([M, hy + 40, right, hy + 40], fill=T["border-l1"])

ry = hy + 40
for index, code in enumerate(rows):
    if index % 2 == 1:
        d.rectangle([M + 1, ry, right - 1, ry + line_h], fill=T["bg-layer-1"])
    d.text((left[0] + 14, ry + 13), str(index + 1), font=F["cell"], fill=T["label-secondary"])
    d.text((left[1] + 14, ry + 13), region_name.get(code, code), font=F["cell_b"], fill=T["label-primary"])
    for j, plan in enumerate(shown):
        amount = price_of(code, plan)
        text = money(amount)
        best = plan == focus and amount is not None and amount == cheapest
        cx = left[2 + j] + cols[2 + j][1] - 14 - d.textlength(text, font=F["cell"])
        d.text((cx, ry + 13), text, font=F["cell_b"] if best else F["cell"], fill=T["success"] if best else T["label-primary"])
        if best:
            tag = "最便宜"
            tw = d.textlength(tag, font=F["badge"]) + 12
            d.rounded_rectangle([cx - tw - 8, ry + 14, cx - 8, ry + 32], radius=9, fill="#e8f5ee")
            d.text((cx - tw - 2, ry + 15), tag, font=F["badge"], fill=T["success"])
    ratio = row_ratio(code)
    rtext = f"{ratio:.2f}×" if ratio is not None else "—"
    rx = left[-1] + cols[-1][1] - 14 - d.textlength(rtext, font=F["cell"])
    d.text((rx, ry + 13), rtext, font=F["cell"], fill=T["label-primary"] if ratio is not None else T["label-secondary"])
    ry += line_h
    if index < len(rows) - 1:
        d.line([M + 1, ry, right - 1, ry], fill=T["border-l1"])

d.text((M, ry + 12), f"来源：各 Storefront App Store 内购价 · 每日 {snap.get('date', '')} 更新 · 换算仅供比较", font=F["badge"], fill=T["label-secondary"])

img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT} ({W}x{H}) rows={len(rows)} focus={focus} low={low} high={high} spread={spread_text}")
