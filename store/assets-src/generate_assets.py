#!/usr/bin/env python3
"""Export original, explicitly labelled 0.2 Chrome Web Store diagrams."""
from pathlib import Path
import argparse
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BASE = Path(__file__).resolve().parents[1]
PROJECT = BASE.parent
OUT = BASE / 'assets'
SCALE = 2
INK = '#f4f8ff'
MUTED = '#a9bbd3'
CYAN = '#9fe8ef'
EN_PATH = '/System/Library/Fonts/Avenir Next.ttc'
CN_PATH = '/System/Library/Fonts/STHeiti Medium.ttc'


def font(size, bold=False, locale='en'):
    if locale == 'zh-CN':
        return ImageFont.truetype(CN_PATH, round(size*SCALE), index=1)
    return ImageFont.truetype(EN_PATH, round(size*SCALE), index=0 if bold else 5)


def xy(box):
    return tuple(round(n*SCALE) for n in box)


def text(draw, position, value, size, fill=INK, bold=False, locale='en'):
    draw.text(xy(position), value, font=font(size, bold, locale), fill=fill, anchor='lt', stroke_width=0)


def line(draw, points, fill, width=1):
    draw.line([xy(p) for p in points], fill=fill, width=round(width*SCALE), joint='curve')


def gradient(size, top, bottom):
    a = Image.new('RGB', (1,1), top).getpixel((0,0))
    b = Image.new('RGB', (1,1), bottom).getpixel((0,0))
    im = Image.new('RGB', (1,size[1]))
    for y in range(size[1]):
        t = y / max(1,size[1]-1)
        im.putpixel((0,y),tuple(round(a[i]*(1-t)+b[i]*t) for i in range(3)))
    return im.resize(size)


def background(w,h):
    im = gradient((w*SCALE,h*SCALE),'#071522','#102739').convert('RGBA')
    glow = Image.new('RGBA', im.size)
    d = ImageDraw.Draw(glow)
    d.ellipse(xy((w*.44,-h*.6,w*1.18,h*.62)),fill=(62,122,156,44))
    d.ellipse(xy((-w*.2,h*.4,w*.6,h*1.35)),fill=(39,108,134,35))
    glow = glow.filter(ImageFilter.GaussianBlur(90*SCALE))
    return Image.alpha_composite(im,glow)


def icon(im, box):
    x,y,w,h=box
    asset=Image.open(PROJECT/'icons/128.png').convert('RGBA').resize(xy((w,h)),Image.Resampling.LANCZOS)
    im.alpha_composite(asset,xy((x,y)))


def save(im, filename, directory=OUT):
    im.convert('RGB').resize((im.width//SCALE,im.height//SCALE),Image.Resampling.LANCZOS).save(directory/filename,optimize=True)


def landscape(w,h):
    im=gradient((w*SCALE,h*SCALE),'#142d49','#698b9a').convert('RGBA')
    d=ImageDraw.Draw(im)
    d.ellipse(xy((w*.69,h*.13,w*.69+h*.2,h*.33)),fill='#e1e7d9')
    d.polygon([xy(p) for p in [(0,h*.65),(w*.16,h*.3),(w*.29,h*.58),(w*.42,h*.2),(w*.63,h*.68),(w*.79,h*.36),(w,h*.65),(w,h),(0,h)]],fill='#456675')
    d.polygon([xy(p) for p in [(0,h*.69),(w*.15,h*.57),(w*.32,h*.76),(w*.49,h*.39),(w*.67,h*.73),(w*.88,h*.48),(w,h*.63),(w,h),(0,h)]],fill='#244d60')
    d.polygon([xy(p) for p in [(0,h*.79),(w*.2,h*.72),(w*.41,h*.84),(w*.69,h*.66),(w,h*.81),(w,h),(0,h)]],fill='#143b4e')
    d.rectangle(xy((0,h*.84,w,h)),fill='#173b4b')
    for i in range(6):
        yy=h*(.875+i*.019)
        xx=w*(.14+(i%3)*.09)
        line(d,[(xx,yy),(xx+w*(.22+i*.02),yy)],'#5b8895',.8)
    return im


def shadow(im, box, radius=18, alpha=85, blur=18):
    layer=Image.new('RGBA',im.size)
    d=ImageDraw.Draw(layer)
    x,y,w,h=box
    d.rounded_rectangle(xy((x,y+8,x+w,y+h+8)),radius=radius*SCALE,fill=(0,0,0,alpha))
    im.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur*SCALE)))


def site_controls(im, box):
    x,y,w,h=box
    d=ImageDraw.Draw(im)
    d.rectangle(xy((x,y+h*.82,x+w,y+h)),fill='#102d3bcc')
    line(d,[(x+w*.05,y+h*.87),(x+w*.95,y+h*.87)],'#a9c6d1',1)
    line(d,[(x+w*.05,y+h*.87),(x+w*.38,y+h*.87)],'#e5f8f7',1.8)
    d.polygon([xy(p) for p in [(x+w*.055,y+h*.915),(x+w*.055,y+h*.965),(x+w*.078,y+h*.94)]],fill='#e5f8f7')


def illustration(im, box, mode='placeholder', locale='en'):
    x,y,w,h=box
    shadow(im,box,12,105,18)
    d=ImageDraw.Draw(im)
    d.rounded_rectangle(xy((x,y,x+w,y+h)),radius=12*SCALE,fill='#1a2b3c',outline='#476074',width=SCALE)
    # Both windows are Chrome windows. Tabs are illustrated, not captured UI.
    top=max(25,min(43,w*.067))
    for i,c in enumerate(['#f48c8c','#e8c67b','#83c9ab']):
        r=max(2,min(3,w*.009))
        d.ellipse(xy((x+10+i*(r*2+5),y+top*.43-r,x+10+i*(r*2+5)+2*r,y+top*.43+r)),fill=c)
    tab_x=x+max(49,w*.13)
    tab_w=w*.38
    d.rounded_rectangle(xy((tab_x,y+top*.18,tab_x+tab_w,y+top)),radius=5*SCALE,fill='#2c4559')
    if w>=350:
        text(d,(tab_x+12,y+top*.38),'山海之间' if locale == 'zh-CN' else 'Mountain Lake',max(10,min(14,w*.025)),fill='#cbdde7',locale=locale)
    if mode!='player':
        for i in range(2):
            left=tab_x+tab_w+8+i*w*.13
            d.rounded_rectangle(xy((left,y+top*.3,left+w*.11,y+top*.75)),radius=4*SCALE,fill='#314657')
    content=(x+1,y+top,w-2,h-top-1)
    cx,cy,cw,ch=content
    if mode=='page':
        # Original-demo website diagram after its tab has returned; no UI capture.
        d.rectangle(xy((cx,cy,cx+cw,cy+ch)),fill='#eff3f6')
        d.ellipse(xy((cx+22,cy+15,cx+37,cy+30)),fill='#467286')
        d.rounded_rectangle(xy((cx+49,cy+19,cx+cw*.34,cy+25)),radius=2*SCALE,fill='#a9bbc6')
        scene_box=(cx+22,cy+49,cw*.66,ch-72)
        sx,sy,sw,sh=scene_box
        im.alpha_composite(landscape(round(sw),round(sh)),xy((sx,sy)))
        site_controls(im,scene_box)
        d=ImageDraw.Draw(im)
        right=cx+cw*.73
        d.rounded_rectangle(xy((right,cy+49,cx+cw-22,cy+ch-23)),radius=8*SCALE,fill='#ffffff',outline='#dbe4e9',width=SCALE)
        for i in range(5):
            line(d,[(right+16,cy+72+i*22),(cx+cw-40-(i%2)*22,cy+72+i*22)],'#c1ced6',2)
        return
    scene=landscape(round(cw),round(ch))
    if mode=='placeholder':
        scene=scene.filter(ImageFilter.GaussianBlur(28*SCALE))
        scene=Image.alpha_composite(scene,Image.new('RGBA',scene.size,(9,20,31,55)))
    im.alpha_composite(scene,xy((cx,cy)))
    if mode=='placeholder':
        d=ImageDraw.Draw(im)
        sz=max(8,min(17,w*.045))
        message='点按以退出全屏幕' if locale == 'zh-CN' else 'Click to exit fullscreen'
        f=font(sz,locale=locale)
        tw=d.textlength(message,font=f)
        d.text((round((x+w/2)*SCALE-tw/2),round((cy+ch*.5)*SCALE)),message,font=f,fill='#d4dde3',anchor='lm')
    else:
        # These abstract controls belong to the website's original player.
        site_controls(im,content)


def promo_small():
    im=background(440,280)
    d=ImageDraw.Draw(im)
    icon(im,(22,20,29,29))
    text(d,(62,27),'Full-Screen Assistant',15,bold=True)
    text(d,(348,29),'Illustration',10,fill=MUTED)
    text(d,(23,86),'Video fullscreen',26)
    text(d,(23,130),'Browser stays.',26)
    text(d,(25,235),'Separate video. Same browser.',12,fill=MUTED)
    illustration(im,(256,72,153,102),'placeholder')
    illustration(im,(250,151,169,107),'player')
    save(im,'promo-small-440x280.png')


def promo_marquee():
    im=background(1400,560)
    d=ImageDraw.Draw(im)
    icon(im,(58,43,46,46))
    text(d,(122,55),'Full-Screen Assistant',24,bold=True)
    text(d,(1178,58),'Feature illustration',14,fill=MUTED)
    text(d,(60,168),'Video fullscreen.',60)
    text(d,(60,251),'Browser stays.',60)
    text(d,(64,391),'Keep your original browser window.',24,fill=MUTED)
    line(d,[(64,477),(515,477)],'#2a495c',1)
    text(d,(64,493),'A dedicated video window. Your browser stays.',15,fill=CYAN)
    illustration(im,(779,70,532,335),'placeholder')
    illustration(im,(695,285,518,245),'player')
    save(im,'promo-marquee-1400x560.png')


def screenshot_header(im,number,headline,subline,locale='en'):
    d=ImageDraw.Draw(im)
    icon(im,(51,35,30,30))
    text(d,(94,42),'Full-Screen Assistant',17,bold=True)
    text(d,(1170,42),f'0{number}',17,fill=CYAN,bold=True)
    text(d,(52,100),headline,45,locale=locale)
    text(d,(55,165),subline,21,fill=MUTED,locale=locale)


def screenshots():
    # Version 0.2 uses labelled diagrams until current HTTP captures are supplied.
    # Archived 0.1 source/restored JPGs are deliberately never read here.
    for stale in ['screenshot-01-independent-1280x800.png',
                  'screenshot-02-browser-1280x800.png',
                  'screenshot-03-return-1280x800.png']:
        (OUT/stale).unlink(missing_ok=True)
    im=background(1280,800)
    screenshot_header(im,1,'Keep your browser. Watch in fullscreen.','Feature illustration: the website player opens in a separate window.')
    d=ImageDraw.Draw(im)
    text(d,(53,255),'Original browser · blurred placeholder',21,fill=CYAN)
    text(d,(664,255),'Original website player · fullscreen',21,fill=CYAN)
    illustration(im,(52,302,564,378),'placeholder')
    illustration(im,(664,302,564,378),'player')
    save(im,'screenshot-01-browser-1280x800.png')
    im=background(1280,800)
    screenshot_header(im,2,'Exit fullscreen. Return to your tab.','Feature illustration: the same webpage and player return to your browser.')
    illustration(im,(150,252,980,468),'page')
    save(im,'screenshot-02-restored-1280x800.png')


def chinese_screenshots():
    directory=OUT/'zh-CN'
    directory.mkdir(parents=True,exist_ok=True)
    im=background(1280,800)
    screenshot_header(im,1,'原窗口保留，占位标签页模糊提示','功能示意：网站原播放器独立全屏，原浏览器可继续使用。',locale='zh-CN')
    d=ImageDraw.Draw(im)
    text(d,(53,255),'原浏览器 · 占位标签页',21,fill=CYAN,locale='zh-CN')
    text(d,(664,255),'网站原播放器 · 独立全屏窗口',21,fill=CYAN,locale='zh-CN')
    illustration(im,(52,302,564,378),'placeholder',locale='zh-CN')
    illustration(im,(664,302,564,378),'player',locale='zh-CN')
    save(im,'screenshot-01-browser-1280x800.png',directory)
    im=background(1280,800)
    screenshot_header(im,2,'退出全屏，原标签页原位恢复','功能示意：同一个网页与原播放器回到原浏览器。',locale='zh-CN')
    illustration(im,(150,252,980,468),'page',locale='zh-CN')
    save(im,'screenshot-02-restored-1280x800.png',directory)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--locale',choices=['all','en','zh-CN'],default='all')
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    if args.locale in ['all','en']:
        original=Image.open(PROJECT/'icons/128.png').convert('RGBA')
        icon_image=Image.new('RGB',(128,128),'#202735')
        icon_image.paste(original,(0,0),original)
        icon_image.save(OUT/'store-icon-128.png',optimize=True)
        promo_small()
        promo_marquee()
        screenshots()
    if args.locale in ['all','zh-CN']:
        chinese_screenshots()
    outputs={p.name:{'size':list(Image.open(p).size),'mode':Image.open(p).mode} for p in sorted(OUT.glob('*.png'))}
    localized={p.name:{'size':list(Image.open(p).size),'mode':Image.open(p).mode} for p in sorted((OUT/'zh-CN').glob('*.png'))}
    (OUT/'asset-specs.json').write_text(json.dumps({'product_architecture':'0.2','asset_language':'en','default_for_all_regions':True,'screenshots_ready':True,'screenshot_kind':'labelled original diagrams','capture_sources':[],'files':outputs,'localized_screenshots':{'zh-CN':localized}},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'screenshots_ready':True,'screenshot_kind':'labelled original diagrams','outputs':outputs},ensure_ascii=False))


if __name__=='__main__':
    main()
