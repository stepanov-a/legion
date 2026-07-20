#!/usr/bin/env python3
"""Helper script for PPTX operations. Called by the MCP server."""
import json, sys, os, tempfile, subprocess
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor

def handle_create(args):
    path = args["path"]
    title = args.get("title", "Presentation")
    slides_data = args.get("slides", [])

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    for i, sd in enumerate(slides_data):
        layout = prs.slide_layouts[6]  # blank
        slide = prs.slides.add_slide(layout)

        # Title
        slide_title = sd.get("title", f"Slide {i+1}")
        txBox = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12.3), Inches(1))
        tf = txBox.text_frame
        p = tf.paragraphs[0]
        p.text = slide_title
        p.font.size = Pt(36)
        p.font.bold = True
        p.alignment = PP_ALIGN.LEFT

        # Content
        content = sd.get("content", "")
        if content:
            txBox2 = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(12.3), Inches(5.5))
            tf2 = txBox2.text_frame
            tf2.word_wrap = True
            for j, line in enumerate(content.split("\n")):
                if j == 0:
                    p2 = tf2.paragraphs[0]
                else:
                    p2 = tf2.add_paragraph()
                p2.text = line
                p2.font.size = Pt(18)
                p2.space_after = Pt(6)

    prs.save(path)
    return {"slides": len(slides_data), "path": path}

def handle_analyze(args):
    path = args["path"]
    prs = Presentation(path)
    slides = []
    for i, slide in enumerate(prs.slides):
        shapes_info = []
        for shape in slide.shapes:
            info = {"name": shape.name, "type": str(shape.shape_type)}
            if hasattr(shape, "text") and shape.text:
                info["text"] = shape.text[:200]
            if shape.has_text_frame:
                paragraphs = []
                for p in shape.text_frame.paragraphs:
                    paragraphs.append(p.text)
                info["paragraphs"] = paragraphs
            shapes_info.append(info)
        slides.append({"number": i + 1, "shapes": shapes_info})

    props = {
        "slide_width": prs.slide_width,
        "slide_height": prs.slide_height,
        "slide_count": len(prs.slides),
    }
    return {"properties": props, "slides": slides}

def handle_update_slide(args):
    path = args["path"]
    slide_number = args["slide_number"] - 1  # 0-indexed
    content = args.get("content", "")

    prs = Presentation(path)
    if slide_number < 0 or slide_number >= len(prs.slides):
        raise ValueError(f"Slide {slide_number + 1} out of range (1-{len(prs.slides)})")

    slide = prs.slides[slide_number]

    # Remove existing content shapes (keep layout shapes)
    for shape in list(slide.shapes):
        if shape.has_text_frame:
            sp = shape._element
            sp.getparent().remove(sp)

    # Add content
    txBox = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(12.3), Inches(5.5))
    tf = txBox.text_frame
    tf.word_wrap = True
    for j, line in enumerate(content.split("\n")):
        p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
        p.text = line
        p.font.size = Pt(18)
        p.space_after = Pt(6)

    prs.save(path)
    return {"path": path, "slide": slide_number + 1}

def handle_convert_to_pdf(args):
    input_path = args["path"]
    output_dir = args.get("output_dir", os.path.dirname(input_path))

    result = subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", output_dir, input_path],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"LibreOffice error: {result.stderr.strip()}")

    base = os.path.splitext(os.path.basename(input_path))[0]
    pdf_path = os.path.join(output_dir, f"{base}.pdf")
    return {"pdf_path": pdf_path, "pages": "?"}

def main():
    payload = json.loads(sys.stdin.read())
    cmd = payload["cmd"]
    args = payload.get("args", {})

    handlers = {
        "create": handle_create,
        "analyze": handle_analyze,
        "update_slide": handle_update_slide,
        "convert_to_pdf": handle_convert_to_pdf,
    }

    handler = handlers.get(cmd)
    if not handler:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)

    try:
        result = handler(args)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
