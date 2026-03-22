# Contributing to HAEVN

First off, thank you for considering contributing to HAEVN! It's people like you that make HAEVN such a great tool.

## 🌟 Ways to Contribute

- **Bug reports**: Submit issues for bugs you encounter
- **Feature requests**: Suggest new features or improvements
- **Code contributions**: Submit pull requests for bug fixes or features
- **Documentation**: Improve or translate documentation
- **Platform support**: Add support for new AI platforms

## 🐛 Reporting Bugs

Before creating bug reports, please check the issue list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Screenshots** if applicable
- **Browser version** and OS
- **Console logs** from the background page and options page

## 💡 Requesting Features

Feature requests are welcome! Please provide:

- **Clear title and description**
- **Use case**: Why would this feature be useful?
- **Mockups** or examples if applicable
- **Willingness to implement**: Are you willing to submit a PR?

## 🔧 Development Setup

### Prerequisites

- Node.js 20+ and pnpm
- Chrome or Chromium browser
- Git

### Getting Started

```bash
# Fork and clone the repository
git clone https://github.com/aiamblichus/haevn.git
cd haevn

# Install dependencies
pnpm install

# Build the extension
pnpm run build

# Load in Chrome
# 1. Go to chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the dist/ folder
```

### Development Workflow

```bash
# Make your changes in src/

# Run tests
pnpm test

# Lint your code
pnpm run lint
pnpm run lint:fix  # Auto-fix issues

# Build
pnpm run build

# Reload extension in Chrome
# Go to chrome://extensions/ and click the reload icon
```

## 📝 Code Style

This project uses **Biome** for linting and formatting. The configuration is in `biome.jsonc`.

- 2-space indentation
- 100 character line width
- Double quotes for strings
- Trailing commas

Run `pnpm run lint:fix` before committing to auto-fix style issues.

## 🎯 Pull Request Process

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feature/my-feature
   # or
   git checkout -b fix/my-bugfix
   ```

2. **Make your changes** following the code style

3. **Test your changes**:

   ```bash
   pnpm test
   pnpm run lint
   pnpm run build
   ```

4. **Commit your changes** with clear messages:

   ```
   feat: add support for Perplexity AI
   fix: resolve sync issue with Claude
   docs: update installation instructions
   ```

5. **Push to your fork** and create a pull request

6. **Wait for review** - we'll review your PR as soon as possible

### PR Guidelines

- **Small, focused PRs**: One feature or fix per PR
- **Clear description**: What and why
- **Tests**: Add tests for new functionality
- **Documentation**: Update docs if needed
- **Changelog**: No need to update CHANGELOG.md (automated)

## 🏷️ Versioning & Releases

This project uses [Semantic Versioning](https://semver.org/). We automate releases based on conventional commits.

### Commit Message Format

Please follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

#### Types

- `feat`: New feature (triggers minor version bump)
- `fix`: Bug fix (triggers patch version bump)
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

#### Breaking Changes

For breaking changes, add `BREAKING CHANGE:` in the footer or use `!` after type:

```
feat!: redesign export format

BREAKING CHANGE: Export format changed from v1 to v2.
```

This triggers a major version bump.

### Release Process

Only maintainers can create releases, but here's how it works:

```bash
# Maintainers run:
pnpm run release:patch  # For bug fixes
pnpm run release:minor  # For new features
pnpm run release:major  # For breaking changes
```

See [docs/RELEASE.md](docs/RELEASE.md) for details.

## 🌐 Adding a New Platform

We love adding support for new AI platforms! Here's how:

### 1. Create Provider Directory

```bash
mkdir -p src/providers/newplatform
```

### 2. Implement Components

Create these files in `src/providers/newplatform/`:

- **`model.ts`**: TypeScript types for the platform's data structures
- **`extractor.ts`**: Implements `Extractor<TRaw>` to fetch raw data
- **`transformer.ts`**: Implements `Transformer<TRaw>` to convert to HAEVN format
- **`provider.ts`**: Provider registration and configuration

### 3. Register Provider

In `src/background/init.ts`:

```typescript
import { newplatformProvider } from '../providers/newplatform/provider';

// In the providers array
newplatformProvider,
```

### 4. Update Manifest

Add host permissions in `src/manifest.json`:

```json
"host_permissions": [
  "*://newplatform.com/*"
]
```

### 5. Add Tests

Create `tests/newplatform.test.ts` with tests for your transformer.

### 6. Document

Update README.md to add the platform to the supported platforms table.

## 📚 Resources

- [Architecture Overview](charter/architecture/overview.md)
- [Development Guide](charter/manuals/dev-guide/)
- [Extension API](https://developer.chrome.com/docs/extensions/)
- [React Documentation](https://react.dev/)

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

<div align="center">

**Thank you for contributing to HAEVN! 🎉**

</div>
