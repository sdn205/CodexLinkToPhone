from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
RESOURCE_DIR = ROOT / "assistant" / "resources"
SOURCE = RESOURCE_DIR / "app-icon-reference.png"
PNG_PATH = RESOURCE_DIR / "app-icon.png"
ICO_PATH = RESOURCE_DIR / "app-icon.ico"


def extract_c_mask(source: Image.Image) -> Image.Image:
    # The reference mark is the black rounded square in the upper-left drawer.
    region = source.crop((36, 32, 84, 88)).convert("L")
    pixels = region.load()
    mask = Image.new("L", region.size, 0)
    output = mask.load()

    for y in range(region.height):
        for x in range(region.width):
            value = pixels[x, y]
            if value > 90:
                output[x, y] = max(0, min(255, int((value - 90) * 1.55)))

    bounds = mask.getbbox()
    if not bounds:
        raise RuntimeError("Could not extract the white C from the reference image")
    return mask.crop(bounds)


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    c_mask = extract_c_mask(source)

    size = 1024
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shape_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(shape_layer)
    margin = 54
    draw.rounded_rectangle(
        (margin, margin, size - margin - 1, size - margin - 1),
        radius=270,
        fill=(22, 23, 25, 255),
    )
    canvas.alpha_composite(shape_layer)

    target_height = 390
    target_width = max(1, round(c_mask.width * target_height / c_mask.height))
    c_mask = c_mask.resize((target_width, target_height), Image.Resampling.LANCZOS)
    c_layer = Image.new("RGBA", c_mask.size, (255, 255, 255, 0))
    c_layer.putalpha(c_mask)
    c_x = (size - target_width) // 2
    c_y = (size - target_height) // 2 - 4
    canvas.alpha_composite(c_layer, (c_x, c_y))

    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    canvas.save(PNG_PATH, optimize=True)
    canvas.save(
        ICO_PATH,
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40),
               (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(PNG_PATH)
    print(ICO_PATH)


if __name__ == "__main__":
    main()
