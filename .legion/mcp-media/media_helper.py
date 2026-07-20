#!/usr/bin/env python3
import json, sys, os, subprocess

def ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
                       capture_output=True, text=True, timeout=30)
    return json.loads(r.stdout) if r.stdout else {}

def handle_analyze(args):
    path = args["path"]
    info = ffprobe(path)
    fmt = info.get("format", {})
    streams = info.get("streams", [])
    result = {"format": fmt.get("format_name", "?"), "size": fmt.get("size", "?"), "bitrate": fmt.get("bit_rate", "?")}
    for s in streams:
        t = s.get("codec_type", "?")
        if t == "video":
            result.update({"video_codec": s.get("codec_name", "?"), "width": s.get("width", "?"), "height": s.get("height", "?"), "fps": s.get("avg_frame_rate", "?")})
        elif t == "audio":
            duration = s.get("duration", fmt.get("duration", "?"))
            result.update({"audio_codec": s.get("codec_name", "?"), "channels": s.get("channels", "?"), "sample_rate": s.get("sample_rate", "?"), "duration_sec": duration})
    if "duration_sec" not in result and fmt.get("duration"):
        result["duration_sec"] = fmt["duration"]
    return result

def handle_extract_audio(args):
    path = args["path"]
    output = args["output"]
    subprocess.run(["ffmpeg", "-y", "-i", path, "-vn", "-acodec", "libmp3lame", "-q:a", "2", output],
                   capture_output=True, timeout=120)
    return {"output": output, "size": os.path.getsize(output)}

def handle_generate_image(args):
    from PIL import Image, ImageDraw, ImageFont
    path, text = args["path"], args["text"]
    w, h, color = args.get("width", 800), args.get("height", 400), args.get("color", "#2c3e50")
    img = Image.new("RGB", (w, h), color)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    except:
        font = ImageFont.load_default()
    bbox = draw.multiline_textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x, y = (w - tw) // 2, (h - th) // 2
    draw.multiline_text((x, y), text, fill="white", font=font, align="center")
    img.save(path)
    return {"path": path, "size": os.path.getsize(path)}

def handle_metadata(args):
    path = args["path"]
    info = ffprobe(path)
    fmt = info.get("format", {})
    tags = fmt.get("tags", {})
    ext = os.path.splitext(path)[1].lower()

    result = dict(tags) if tags else {}
    if fmt.get("size"): result["file_size"] = fmt["size"]
    if fmt.get("duration"): result["duration"] = fmt["duration"]
    if fmt.get("bit_rate"): result["bitrate"] = fmt["bit_rate"]

    if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        try:
            from PIL import Image
            from PIL.ExifTags import TAGS
            img = Image.open(path)
            result["width"] = img.width
            result["height"] = img.height
            result["mode"] = img.mode
            exif = img._getexif()
            if exif:
                for k, v in exif.items():
                    name = TAGS.get(k, k)
                    result[f"exif_{name}"] = str(v)[:100]
        except: pass

    return result

def main():
    payload = json.loads(sys.stdin.read())
    cmd, args = payload["cmd"], payload.get("args", {})
    handlers = {"analyze": handle_analyze, "extract_audio": handle_extract_audio,
                "generate_image": handle_generate_image, "metadata": handle_metadata}
    h = handlers.get(cmd)
    if not h: print(json.dumps({"error": f"Unknown: {cmd}"})); sys.exit(1)
    try: print(json.dumps(h(args)))
    except Exception as e: print(json.dumps({"error": str(e)})); sys.exit(1)

if __name__ == "__main__":
    main()
