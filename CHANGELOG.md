# Changelog

All notable changes to HAEVN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-XX

### Added
- Initial public release of HAEVN Chat Exporter
- Support for 10 LLM platforms: Claude, ChatGPT, Gemini, Poe, Qwen, DeepSeek, AI Studio, Grok, Open WebUI, and Claude Code (import)
- Unified local archive with canonical HAEVN.Chat format
- Full-text search across all conversations using Lunr.js
- Bulk sync from all supported platforms
- Export to multiple formats (JSON, Markdown, HTML)
- Import from various sources
- OPFS-based media storage for images and attachments
- Real-time sync status and progress tracking
- Advanced search with filters and sorting
- Conversation tree visualization for branched chats
- Gallery view for media attachments
- Statistics and analytics dashboard
- Automated cleanup with soft-delete and janitor service
- Debug portal for troubleshooting

### Technical
- Manifest V3 Chrome Extension
- TypeScript 5.9.3 with strict mode
- React 18.3 with Tailwind CSS and shadcn/ui
- Dexie for IndexedDB persistence
- Three-tier worker architecture (Service Worker → Offscreen → Web Workers)
- Event-driven UI updates
- Plugin architecture for platform providers

---

## Release Process

This project uses automated releases via GitHub Actions. To create a new release:

1. **Update version manually** in `package.json` and `src/manifest.json`
2. **Commit changes**: `git commit -am "chore: bump version to x.y.z"`
3. **Create and push tag**: 
   ```bash
   git tag -a vx.y.z -m "Release version x.y.z"
   git push origin vx.y.z
   ```
4. **GitHub Actions will**:
   - Run tests
   - Build the extension
   - Create a ZIP artifact
   - Generate changelog from commits
   - Create GitHub Release with attached ZIP
   - Update CHANGELOG.md

Or use the manual workflow dispatch from GitHub Actions UI.

---

For older releases and detailed commit history, see [GitHub Releases](https://github.com/YOUR_USERNAME/haevn/releases).
