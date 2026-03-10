#!/bin/bash
# Generate macOS .icns icon from SVG using built-in tools
# No dependencies required — uses qlmanage + sips + iconutil

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG_FILE="$SCRIPT_DIR/icon.svg"
ICONSET_DIR="$SCRIPT_DIR/icon.iconset"
ICNS_FILE="$SCRIPT_DIR/icon.icns"
PNG_FILE="$SCRIPT_DIR/icon.png"

echo "Generating FinFlow icons..."

# Create iconset directory
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# First, render SVG to a large PNG using qlmanage (built into macOS)
# qlmanage can render SVGs via Quick Look
qlmanage -t -s 1024 -o "$SCRIPT_DIR" "$SVG_FILE" 2>/dev/null

# The output file will be icon.svg.png
LARGE_PNG="$SCRIPT_DIR/icon.svg.png"

if [ ! -f "$LARGE_PNG" ]; then
  # Fallback: try using rsvg-convert if installed
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w 1024 -h 1024 "$SVG_FILE" > "$LARGE_PNG"
  else
    echo "Error: Could not render SVG. Trying Python..."
    # Another fallback: use Python with cairosvg if available
    python3 -c "
import subprocess, sys
try:
    import cairosvg
    cairosvg.svg2png(url='$SVG_FILE', write_to='$LARGE_PNG', output_width=1024, output_height=1024)
except ImportError:
    sys.exit(1)
" 2>/dev/null
    if [ ! -f "$LARGE_PNG" ]; then
      echo "Error: No SVG renderer available. Install with: brew install librsvg"
      exit 1
    fi
  fi
fi

echo "  Rendered SVG to PNG"

# Copy as icon.png
cp "$LARGE_PNG" "$PNG_FILE"

# Generate all required sizes using sips (built into macOS)
for SIZE in 16 32 64 128 256 512; do
  sips -z $SIZE $SIZE "$LARGE_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png" &>/dev/null
  echo "  Generated ${SIZE}x${SIZE}"
done

# Generate @2x variants
for SIZE in 16 32 128 256 512; do
  DOUBLE=$((SIZE * 2))
  sips -z $DOUBLE $DOUBLE "$LARGE_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" &>/dev/null
  echo "  Generated ${SIZE}x${SIZE}@2x"
done

# Convert iconset to icns
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_FILE" 2>/dev/null
if [ -f "$ICNS_FILE" ]; then
  echo "  Generated icon.icns"
else
  echo "  Warning: iconutil failed, trying alternative..."
fi

# Clean up
rm -rf "$ICONSET_DIR"
rm -f "$LARGE_PNG"

echo ""
echo "Done! Generated:"
[ -f "$PNG_FILE" ] && echo "  icon.png  ($(du -h "$PNG_FILE" | cut -f1 | xargs))"
[ -f "$ICNS_FILE" ] && echo "  icon.icns ($(du -h "$ICNS_FILE" | cut -f1 | xargs))"
