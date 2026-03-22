# Release Process & Versioning Guide

This document describes how versioning and releases work for HAEVN Chat Exporter.

## 📦 Release Strategy

HAEVN follows [Semantic Versioning](https://semver.org/) (SemVer) with automated releases via GitHub Actions.

### Version Format: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes (e.g., manifest version changes, data format changes)
- **MINOR**: New features, new platform support (e.g., adding Grok integration)
- **PATCH**: Bug fixes, minor improvements (e.g., fixing sync issues)

### Distribution Channels

1. **GitHub Releases** (Primary): Automated ZIP artifacts attached to each release
2. **Chrome Web Store** (Future): Manual upload after testing GitHub release

---

## 🚀 How to Create a Release

### Option 1: Quick Release (Recommended)

Use the convenience scripts for common release scenarios:

```bash
# Patch release (1.0.0 → 1.0.1) - Bug fixes
pnpm run release:patch

# Minor release (1.0.0 → 1.1.0) - New features
pnpm run release:minor

# Major release (1.0.0 → 2.0.0) - Breaking changes
pnpm run release:major
```

These scripts will:

1. Bump the version in `package.json` and `manifest.json`
2. Prompt you to commit and tag
3. Push to GitHub and trigger the release workflow

### Option 2: Manual Release

For more control over the process:

```bash
# 1. Bump version
pnpm run version:patch  # or version:minor, version:major

# 2. Review changes
git diff

# 3. Commit version bump
git add package.json package-lock.json src/manifest.json
git commit -m "chore: bump version to X.Y.Z"

# 4. Create annotated tag
git tag -a vX.Y.Z -m "Release version X.Y.Z"

# 5. Push to GitHub
git push origin main --tags
```

### Option 3: Manual Trigger via GitHub UI

1. Go to **Actions** → **Release** workflow
2. Click **Run workflow**
3. Enter the version number (e.g., `1.0.1`)
4. Click **Run workflow**

---

## 🔄 What Happens During Release

When you push a tag (e.g., `v1.0.1`), GitHub Actions automatically:

### 1. Build & Test

- ✅ Checkout code
- ✅ Install dependencies (`pnpm ci`)
- ✅ Run linter
- ✅ Run tests
- ✅ Build extension (`pnpm run build`)

### 2. Package

- 📦 Update `manifest.json` with release version
- 📦 Create ZIP artifact: `haevn-extension-v1.0.1.zip`

### 3. Release

- 🏷️ Create GitHub Release
- 📝 Generate changelog from commit history
- 📎 Attach ZIP artifact to release
- 🔄 Update `CHANGELOG.md` in repository

### 4. Post-Release

- ✅ Commit updated `CHANGELOG.md`
- ✅ Commit version updates to `package.json` and `manifest.json`
- ✅ Push changes to main branch

---

## 📝 Commit Message Guidelines

While not strictly enforced, following these conventions helps generate better changelogs:

### Format

```
<type>: <description>

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature (triggers MINOR version bump)
- `fix:` - Bug fix (triggers PATCH version bump)
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### Breaking Changes

For breaking changes that warrant a MAJOR version bump:

```
feat!: redesign data export format

BREAKING CHANGE: Export format changed from v1 to v2.
Users will need to re-export their data.
```

---

## 🛠️ Available pnpm Scripts

### Version Management

```bash
pnpm run version:patch  # Bump patch version (1.0.0 → 1.0.1)
pnpm run version:minor  # Bump minor version (1.0.0 → 1.1.0)
pnpm run version:major  # Bump major version (1.0.0 → 2.0.0)
```

### Release

```bash
pnpm run release:patch  # Bump, commit, tag, and push patch release
pnpm run release:minor  # Bump, commit, tag, and push minor release
pnpm run release:major  # Bump, commit, tag, and push major release
```

### Packaging

```bash
pnpm run package  # Create ZIP artifact locally (for testing)
```

---

## 📊 Release Workflow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Developer Actions                                            │
├─────────────────────────────────────────────────────────────┤
│ 1. pnpm run release:patch                                    │
│    ↓                                                         │
│ 2. Script bumps version in package.json & manifest.json     │
│    ↓                                                         │
│ 3. Git commit & tag created                                 │
│    ↓                                                         │
│ 4. Push to GitHub                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ GitHub Actions (Automated)                                   │
├─────────────────────────────────────────────────────────────┤
│ 5. Tests run                                                │
│    ↓                                                         │
│ 6. Extension built                                          │
│    ↓                                                         │
│ 7. ZIP artifact created                                     │
│    ↓                                                         │
│ 8. GitHub Release created with:                             │
│    - Changelog from commits                                 │
│    - ZIP artifact attached                                  │
│    ↓                                                         │
│ 9. CHANGELOG.md updated                                     │
│    ↓                                                         │
│ 10. Version files committed back to repo                    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ User Downloads                                               │
├─────────────────────────────────────────────────────────────┤
│ Users can download ZIP from:                                │
│ https://github.com/YOUR_USERNAME/haevn/releases/latest     │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Configuration

### GitHub Repository Setup

1. **Enable GitHub Actions**: Already enabled by default
2. **Set permissions**: Workflow has `contents: write` permission
3. **No secrets required** for basic releases (uses `GITHUB_TOKEN`)

### Chrome Web Store Publishing (Optional/Future)

To enable automatic Chrome Web Store publishing, you'll need to:

1. **Get OAuth credentials** from Google Cloud Console
2. **Add secrets** to GitHub repository:
   - `EXTENSION_ID`: Your extension's ID
   - `CLIENT_ID`: OAuth client ID
   - `CLIENT_SECRET`: OAuth client secret
   - `REFRESH_TOKEN`: OAuth refresh token
3. **Uncomment** the `publish-chrome-store` job in `.github/workflows/release.yml`

See [Chrome Web Store API docs](https://developer.chrome.com/docs/webstore/api/) for setup instructions.

---

## 🐛 Troubleshooting

### Release workflow failed

1. Check the **Actions** tab in GitHub for error logs
2. Common issues:
   - Tests failing: Fix tests before releasing
   - Build failing: Run `pnpm run build` locally to debug
   - Lint errors: Run `pnpm run lint:fix` locally

### Version mismatch

If versions get out of sync:

```bash
# Check current versions
node -p "require('./package.json').version"
node -p "require('./src/manifest.json').version"

# Manually sync them
pnpm run version:patch  # This will sync both files
```

### Manual package creation

To create a ZIP without releasing:

```bash
pnpm run build
pnpm run package
# Creates: haevn-extension-v1.0.0.zip
```

---

## 📚 Related Files

- `.github/workflows/release.yml` - Main release workflow
- `.github/workflows/ci.yml` - Continuous integration
- `CHANGELOG.md` - Release history
- `scripts/version-bump.sh` - Version bumping script
- `scripts/quick-release.sh` - Quick release script

---

## 🎯 Best Practices

1. **Test before releasing**: Always run `pnpm test` and `pnpm run build` locally
2. **Write good commit messages**: Helps generate meaningful changelogs
3. **Update CHANGELOG.md manually** for significant changes if needed
4. **Test the ZIP**: Download and test the release artifact before announcing
5. **Use semantic versioning**: Don't skip versions, follow MAJOR.MINOR.PATCH
6. **Document breaking changes**: Clearly note breaking changes in commit messages

---

## 📖 Resources

- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/api/)
