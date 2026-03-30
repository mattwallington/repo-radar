#!/bin/bash
# Create simple placeholder icons using ImageMagick or sips
# These are basic 22x22 icons - replace with proper designs later

# Try ImageMagick first
if command -v convert &> /dev/null; then
    convert -size 22x22 xc:transparent -fill "rgb(100,150,255)" -draw "circle 11,11 11,2" icon.png
    convert -size 22x22 xc:transparent -fill "rgb(255,200,0)" -draw "circle 11,11 11,2" icon-syncing.png
    convert -size 22x22 xc:transparent -fill "rgb(255,50,50)" -draw "circle 11,11 11,2" icon-error.png
    echo "Icons created with ImageMagick"
elif command -v sips &> /dev/null; then
    # Create basic colored squares as placeholders
    echo "Creating placeholder icons..."
    # For now, create empty files - user can replace with proper icons
    touch icon.png icon-syncing.png icon-error.png
    echo "Placeholder icon files created - replace with 22x22 PNG icons"
else
    # Create empty placeholder files
    touch icon.png icon-syncing.png icon-error.png
    echo "Placeholder icon files created - replace with 22x22 PNG icons"
fi
