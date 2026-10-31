# -*- coding: utf-8 -*-
"""
地理图册 PDF → 页图（给人看）+ 低分辨率副本（给视觉模型转写）

用法:
  python scripts/pdf2geo-atlas-pages.py
  python scripts/pdf2geo-atlas-pages.py --pdf xxx.pdf --slug geography-required1 \
      --start 1 --end 60 --dpi 160 --vision-width 1100

产物:
  public/geo-atlas/<slug>/pNNN.jpg          160dpi 页图，聊天/原页核对用
  tmp-geo-atlas/<slug>/pNNN.jpg             缩到约 1100px 宽，视觉转写用
  deliverables/<slug>.pages.json           页清单（尺寸/字节数/PDF 页码）
"""
import pymupdf, os, json, argparse

DEFAULT_PDF = r"D:\xiaz\教材下载\普通高中教科书·地理图册必修 第一册.pdf"
DEFAULT_SLUG = "geography-required1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=DEFAULT_PDF)
    ap.add_argument("--slug", default=DEFAULT_SLUG)
    ap.add_argument("--start", type=int, default=1, help="起始页，1-based，含")
    ap.add_argument("--end", type=int, default=0, help="结束页，1-based，含；0=到末页")
    ap.add_argument("--dpi", type=int, default=160)
    ap.add_argument("--vision-width", type=int, default=1100)
    ap.add_argument("--quality", type=int, default=85)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "public", "geo-atlas", args.slug)
    vision_dir = os.path.join(root, "tmp-geo-atlas", args.slug)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(vision_dir, exist_ok=True)

    doc = pymupdf.open(args.pdf)
    end = len(doc) if args.end <= 0 else min(args.end, len(doc))
    manifest = []
    for pno in range(args.start - 1, end):
        page = doc[pno]
        pix = page.get_pixmap(dpi=args.dpi, colorspace=pymupdf.csRGB)
        name = f"p{pno + 1:03d}.jpg"
        out_path = os.path.join(out_dir, name)
        pix.save(out_path, jpg_quality=args.quality)

        vdpi = int(round(args.vision_width * 72.0 / page.rect.width))
        vpix = page.get_pixmap(dpi=vdpi, colorspace=pymupdf.csRGB)
        vpix.save(os.path.join(vision_dir, name), jpg_quality=80)

        manifest.append({
            "pdfPage": pno + 1,
            "file": name,
            "width": pix.width,
            "height": pix.height,
            "bytes": os.path.getsize(out_path),
        })
        print(f"{name}  {pix.width}x{pix.height}  {os.path.getsize(out_path) // 1024}KB")

    doc.close()
    stats_path = os.path.join(root, "deliverables", f"{args.slug}.pages.json")
    os.makedirs(os.path.dirname(stats_path), exist_ok=True)
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    total = sum(m["bytes"] for m in manifest)
    print(f"\n完成 {len(manifest)} 页，共 {total / 1024 / 1024:.1f}MB")
    print(f"页图: {out_dir}")
    print(f"转写副本: {vision_dir}")
    print(f"清单: {stats_path}")


if __name__ == "__main__":
    main()
