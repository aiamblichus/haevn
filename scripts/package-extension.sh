#!/bin/bash
# Script to package the HAEVN extension for Chrome Web Store submission

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}📦 HAEVN Extension Packaging Script${NC}"
echo ""

# Check if dist folder exists
if [ ! -d "dist" ]; then
    echo -e "${RED}❌ Error: dist/ folder not found${NC}"
    echo "Run 'npm run build' first to create the dist folder"
    exit 1
fi

# Get version from manifest
VERSION=$(node -p "require('./dist/manifest.json').version")
echo -e "${YELLOW}Version found: ${VERSION}${NC}"

# Create filename
ZIP_NAME="haevn-extension-v${VERSION}.zip"

# Remove old zip if exists
if [ -f "$ZIP_NAME" ]; then
    echo -e "${YELLOW}⚠️  Removing existing ${ZIP_NAME}${NC}"
    rm "$ZIP_NAME"
fi

# Create zip from dist folder
echo -e "${GREEN}📦 Creating ${ZIP_NAME} from dist/ folder...${NC}"
cd dist
zip -r "../${ZIP_NAME}" . -x "*.DS_Store" "*.git*"
cd ..

# Check zip was created
if [ -f "$ZIP_NAME" ]; then
    SIZE=$(du -h "$ZIP_NAME" | cut -f1)
    echo -e "${GREEN}✅ Successfully created ${ZIP_NAME} (${SIZE})${NC}"
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "1. Test the extension by loading dist/ folder in Chrome"
    echo "2. Go to https://chrome.google.com/webstore/devconsole"
    echo "3. Click 'New Item' and upload ${ZIP_NAME}"
    echo ""
    echo -e "${GREEN}📋 Don't forget:${NC}"
    echo "- Privacy policy URL"
    echo "- Store listing assets (screenshots, promotional tiles)"
    echo "- Store listing description"
else
    echo -e "${RED}❌ Error: Failed to create ZIP file${NC}"
    exit 1
fi

