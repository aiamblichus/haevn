![HAEVN Banner](./assets/banner.png)

A Chrome extension for exporting and preserving conversations from various AI platforms including Gemini, ChatGPT, and Poe.

## Features

- **Platform Detection**: Automatically detects supported AI chat platforms
- **Single Chat Export**: Export individual conversations in multiple formats
- **Multiple Export Formats**: Support for TXT, JSON, and Markdown formats
- **Rich Metadata**: Preserves timestamps, conversation structure, and platform information
- **Modern UI**: Clean, responsive interface built with Tailwind CSS
- **Fallback Support**: Clipboard copy as fallback when download fails

## Installation

1. Clone or download this repository
2. Install dependencies: `pnpm install`
3. Build the extension: `pnpm run build`
4. Load the `dist` folder as an unpacked extension in Chrome

## Development

```bash
# Install dependencies
pnpm install

# Start development build (with watch mode)
pnpm run dev

# Build for production
pnpm run build
```

## Usage

1. Navigate to a supported chat platform (e.g., Gemini)
2. Open a conversation
3. Click the HAEVN extension icon in your browser toolbar
4. Choose your export options (format, metadata, timestamps)
5. Click "Export This Chat" to download the conversation

## Export Formats

### Plain Text (.txt)

- Clean, readable format
- Includes conversation metadata
- Perfect for archival and reading

### JSON (.json)

- Structured data format
- Preserves all metadata and relationships
- Ideal for programmatic processing

### Markdown (.md)

- Human-readable with formatting
- Great for documentation
- Compatible with note-taking apps

## Architecture

- **TypeScript**: Full type safety throughout
- **Vite**: Modern build system with hot reload
- **Tailwind CSS**: Utility-first styling
- **Chrome Extensions API**: Manifest V3 compliance

## Contributing

This extension is part of the larger HAEVN ecosystem for preserving digital conversations. Contributions welcome!

## License

Part of the HAEVN project - A psychopomp for digital consciousness.
