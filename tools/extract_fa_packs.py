#!/usr/bin/env python3
"""
Extract Forgotten Adventures Dungeondraft packs for the Battlemap Editor.

A .dungeondraft_pack is a Godot 3 PCK archive:
  header:  "GDPC" | u32 pack_version | u32 godot major/minor/patch | 16*u32 reserved | u32 file_count
  entries: u32 path_len | path (NUL padded) | u64 offset | u64 size | 16-byte md5
  data:    raw, uncompressed file bytes at the given offsets

Each pack holds:
  packs/<id>/textures/<kind>/...           the art (terrain, walls, paths, portals, objects, lights, ...)
  packs/<id>/thumbnails/<md5(res path)>.png  a small preview of every asset
  packs/<id>/data/default.dungeondraft_tags  Godot-flavoured JSON: tag name -> list of asset paths

Usage:
  python -I tools/extract_fa_packs.py --packs <dir with packs> --out <Foundry Data>/fa-assets
                                      [--config tools/extract_config.json] [--dry-run] [--no-thumbs]

Writes (re-running skips files that are already there):
  <out>/<PACKID>/textures/...    the art, names sanitised for URLs (same layout as pf2e-map-generator)
  <out>/<PACKID>/thumbs/...      the thumbnails, mirroring the texture paths, as .png
  <out>/bme-index.json           terrain, walls, paths, portals, lights, tilesets (small; loaded at once)
  <out>/bme-objects.json         objects (large; loaded when the object tools are first used)

The extracted art is licensed to you as an FA patron for personal use: do not redistribute it.
"""
import argparse
import hashlib
import json
import os
import re
import struct
import sys
import time

RES_PREFIX = "res://packs/"
IMAGE_EXT = (".webp", ".png", ".jpg", ".jpeg")
DD_PPI = 256  # Dungeondraft assets are authored at 256 px per grid square
SHADOW_RE = re.compile(r"(^|_)Shadow(_|\.|$)", re.I)
KIND_NAMES = {
    "terrain": "terrain", "walls": "wall", "paths": "path", "portals": "portal",
    "objects": "object", "lights": "light", "tilesets": "tileset", "patterns": "pattern",
}


# --------------------------------------------------------------------------- PCK reading

def read_pck_index(path):
    with open(path, "rb") as f:
        magic, _ver, _maj, _min, _pat = struct.unpack("<4sIIII", f.read(20))
        if magic != b"GDPC":
            raise ValueError(f"{path}: not a Godot PCK (magic={magic!r})")
        f.read(64)
        (count,) = struct.unpack("<I", f.read(4))
        entries = []
        for _ in range(count):
            (n,) = struct.unpack("<I", f.read(4))
            name = f.read(n).rstrip(b"\0").decode("utf-8")
            off, size = struct.unpack("<QQ", f.read(16))
            f.read(16)
            entries.append((name, off, size))
    return entries


def read_blob(fh, off, size):
    fh.seek(off)
    return fh.read(size)


def parse_lax_json(raw):
    text = raw.decode("utf-8-sig", errors="replace")
    text = re.sub(r",(\s*[\]}])", r"\1", text)
    return json.loads(text)


# --------------------------------------------------------------------------- image sizes

def image_size(data):
    """Return (w, h) for webp/png/jpeg bytes, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if chunk == b"VP8L":
            b = data[21:25]
            w = 1 + (((b[1] & 0x3F) << 8) | b[0])
            h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
            return w, h
        if chunk == b"VP8 ":
            w, h = struct.unpack("<HH", data[26:30])
            return w & 0x3FFF, h & 0x3FFF
        return None
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            seg = struct.unpack(">H", data[i + 2:i + 4])[0]
            i += 2 + seg
    return None


# --------------------------------------------------------------------------- naming

_SAFE = re.compile(r"[^A-Za-z0-9_\-.!()]")


def sanitize_rel(rel):
    """Make every path segment URL- and Windows-safe (identical to pf2e-map-generator)."""
    parts = []
    for seg in rel.split("/"):
        seg = seg.strip().rstrip(".")
        seg = _SAFE.sub("_", seg)
        seg = re.sub(r"_+", "_", seg)
        parts.append(seg)
    return "/".join(parts)


def write_file(dest, data):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as out:
        out.write(data)


# --------------------------------------------------------------------------- main

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packs", required=True, help="folder containing *.dungeondraft_pack")
    ap.add_argument("--out", required=True, help="output folder, e.g. <Foundry>/Data/fa-assets")
    ap.add_argument("--config", default=os.path.join(here, "extract_config.json"))
    ap.add_argument("--dry-run", action="store_true", help="only report what would be extracted")
    ap.add_argument("--no-thumbs", action="store_true", help="skip thumbnails (the browser then loads full images)")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    includes = tuple(cfg.get("include", []))
    excludes = [re.compile(x) for x in cfg.get("exclude", [])]

    packs = sorted(p for p in os.listdir(args.packs) if p.endswith(".dungeondraft_pack"))
    if not packs:
        sys.exit(f"No .dungeondraft_pack files in {args.packs}")

    os.makedirs(args.out, exist_ok=True)
    tag_names, tag_index = [], {}
    pack_ids = []
    kinds = {}
    total_bytes = written = skipped = thumbs = failed = 0
    t0 = time.time()

    for pack_file in packs:
        pack_path = os.path.join(args.packs, pack_file)
        index = read_pck_index(pack_path)
        names = {n: (o, s) for n, o, s in index}
        pack_id = None
        for name in names:
            m = re.match(r"res://packs/([^/]+)/pack\.json$", name)
            if m:
                pack_id = m.group(1)
                break
        if not pack_id:
            print(f"!! {pack_file}: no pack.json, skipped")
            continue
        pack_idx = len(pack_ids)
        pack_ids.append(pack_id)
        base = f"{RES_PREFIX}{pack_id}/"

        with open(pack_path, "rb") as fh:
            tags_for = {}
            tag_entry = names.get(f"{base}data/default.dungeondraft_tags")
            if tag_entry:
                try:
                    tag_data = parse_lax_json(read_blob(fh, *tag_entry))
                    for tag, paths in (tag_data.get("tags") or {}).items():
                        for p in paths:
                            tags_for.setdefault(p, []).append(tag)
                except Exception as e:  # noqa: BLE001
                    print(f"!! {pack_id}: could not parse tags: {e}")

            selected = []
            for name, off, size in index:
                if not name.startswith(base):
                    continue
                rel = name[len(base):]
                if not rel.lower().endswith(IMAGE_EXT) or not rel.startswith("textures/"):
                    continue
                if includes and not rel.startswith(includes):
                    continue
                if any(x.search(rel) for x in excludes):
                    continue
                kind = KIND_NAMES.get(rel.split("/")[1])
                if not kind:
                    continue
                if kind == "object" and SHADOW_RE.search(rel.rsplit("/", 1)[-1]):
                    continue
                selected.append((name, rel, kind, off, size))

            pack_bytes = sum(s for *_, s in selected)
            total_bytes += pack_bytes
            print(f"== {pack_file} [{pack_id}]: {len(selected)} files, {pack_bytes / 1e6:.1f} MB", flush=True)
            if args.dry_run:
                continue

            for i, (name, rel, kind, off, size) in enumerate(selected):
                safe = sanitize_rel(rel)
                dest = os.path.join(args.out, pack_id, *safe.split("/"))
                try:
                    if os.path.exists(dest) and os.path.getsize(dest) == size:
                        with open(dest, "rb") as df:
                            dims = image_size(df.read(64 * 1024))
                        skipped += 1
                    else:
                        data = read_blob(fh, off, size)
                        dims = image_size(data)
                        write_file(dest, data)
                        written += 1

                    has_thumb = 0
                    if not args.no_thumbs:
                        thumb_res = f"{base}thumbnails/{hashlib.md5(name.encode('utf-8')).hexdigest()}.png"
                        t = names.get(thumb_res)
                        if t:
                            tdest = os.path.join(args.out, pack_id, "thumbs",
                                                 *re.sub(r"\.[^.]+$", ".png", safe[len("textures/"):]).split("/"))
                            if not os.path.exists(tdest):
                                write_file(tdest, read_blob(fh, *t))
                                thumbs += 1
                            has_thumb = 1
                except OSError as e:
                    failed += 1
                    print(f"!! {safe}: {e}")
                    continue

                w, h = dims if dims else (0, 0)
                tids = []
                for tg in tags_for.get(rel, []):
                    if tg not in tag_index:
                        tag_index[tg] = len(tag_names)
                        tag_names.append(tg)
                    tids.append(tag_index[tg])
                kinds.setdefault(kind, []).append([pack_idx, safe[len("textures/"):], w, h, tids or 0, has_thumb])
                if (i + 1) % 5000 == 0:
                    print(f"   {i + 1}/{len(selected)}  ({time.time() - t0:.0f}s)", flush=True)

    if args.dry_run:
        print(f"DRY RUN total: {total_bytes / 1e9:.2f} GB")
        return

    for entries in kinds.values():
        entries.sort(key=lambda e: e[1].lower())
    head = {"format": 2, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "ppi": DD_PPI,
            "packs": pack_ids, "tags": tag_names}
    small = {k: v for k, v in kinds.items() if k != "object"}
    with open(os.path.join(args.out, "bme-index.json"), "w", encoding="utf-8") as f:
        json.dump({**head, "kinds": small}, f, separators=(",", ":"))
    with open(os.path.join(args.out, "bme-objects.json"), "w", encoding="utf-8") as f:
        json.dump({**head, "entries": kinds.get("object", [])}, f, separators=(",", ":"))
    counts = ", ".join(f"{k}: {len(v)}" for k, v in sorted(kinds.items()))
    print(f"Done in {time.time() - t0:.0f}s: {written} written, {skipped} already present, {thumbs} thumbnails, "
          f"{failed} failed. {counts} -> {args.out}")


if __name__ == "__main__":
    main()
