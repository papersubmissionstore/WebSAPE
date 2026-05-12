# WebSAPE Extension - Standalone Version

A browser extension for LLM-driven web automation that works **completely standalone, with no server dependencies**.

This is the standalone version of the WebSAPE browser extension from the WebSAPE paper. All instructions and configurations are bundled with the extension, making it fully independent and ready for reproducibility.

## Key Features

- 🚀 **Fully Standalone** — No server, no external dependencies
- 🎯 **LLM-Powered** — Uses Claude or other LLMs for intelligent web automation
- 🔗 **Multi-Intent Support** — Works with WebArena, CUA, WorkArena, and more
- 📦 **Pre-bundled** — Includes instructions for 10 common domains
- 🛠️ **Developer-Friendly** — Open source, MIT licensed

## Quick Start

### Installation

1. **Clone or download the repository**
   ```bash
   git clone https://github.com/papersubmissionstore/WebSAPE.git
   cd WebSAPE
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the extension**
   ```bash
   npm run build
   ```

4. **Load in Chrome/Edge**
   - Open Chrome/Edge → `chrome://extensions/` (or `edge://extensions/`)
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `dist/` folder

### Usage

1. Open the extension (click icon in browser toolbar)
2. Enter your LLM API configuration (Claude, etc.)
3. Enter your task/workflow in the sidebar
4. Click "Run" to execute

The extension will:
- Analyze your task
- Load relevant bundled instructions for the website
- Execute the workflow using the LLM
- Save results and execution traces

## Bundled Instructions

The extension includes navigation instructions for these domains:

- **Test Sites**: BizArena Outlook

Instructions are automatically loaded when you navigate to these sites.

## Adding New Instructions

To add instructions for new domains:

1. Create a markdown file in `public/instructions/domains/`
2. Name it `domain-name.md` (e.g., `example.com.md`)
3. Format: Include a `#` title and navigation tips
4. Rebuild: `npm run build`

Example:
```markdown
# Example.com Quick Reference

## Navigation
- Home: Click logo
- Search: Use search bar

## Common Actions
- Find items: Use search
- View details: Click item
```

## System Requirements

- **Browser**: Chrome 90+, Edge 90+ (requires Manifest V3 support)
- **LLM**: Claude (Anthropic) or compatible LLM API
- **Node.js**: 18+ (for building)

## Configuration

Configure via the extension sidebar:

- **LLM Provider**: Choose Claude, OpenAI, or local LLM
- **API Key**: Your LLM provider's API key
- **Model**: Which model to use (e.g., claude-3-5-sonnet)
- **Instructions**: Enable/disable instruction loading

No server configuration is needed—all settings are local.

## How It Works

1. **Task Submission** → You describe what you want to do
2. **Instruction Loading** → Extension loads bundled instructions for the domain
3. **LLM Planning** → Claude generates a step-by-step plan
4. **Web Automation** → Extension executes clicks, typing, form filling
5. **Result Capture** → Execution traces and results are saved locally

## For Researchers

This extension was developed as part of the **WebSAPE** paper on efficient web automation evaluation. For details, see `PAPER.md`.

### Reproducibility

All results are saved locally in your browser's storage and the extension's output folder. To reproduce results:

1. Use the same LLM model and temperature settings
2. Enable the same instruction and feature options
3. Run the same tasks and workflows

### Contributing

We welcome improvements! See `CONTRIBUTING.md` for guidelines.

## Troubleshooting

**Extension won't load:**
- Ensure it's Chrome/Edge 90+
- Check that `dist/` folder exists (run `npm run build`)
- Verify the manifest file is valid

**Instructions not loading:**
- Check that the domain matches a bundled instruction file
- Verify `enableInstructions` is ON in settings
- Check browser console for errors

**Tasks failing:**
- Ensure your LLM API key is valid
- Check LLM rate limits and quota
- Review execution logs for error messages

## Architecture

```
extension-standalone/
├── src/
│   ├── background/     # Service worker, task execution
│   ├── sidebar/        # UI for entering tasks
│   ├── options/        # Settings page
│   ├── prompts/        # LLM prompt templates
│   └── utils/          # Helpers (instruction loader, logging, etc.)
├── public/
│   ├── instructions/   # Bundled instruction files
│   └── manifest.json   # Extension configuration
└── dist/              # Built extension (after npm run build)
```

## Key Files

- `src/utils/instruction-loader.ts` — Loads bundled instructions by domain
- `src/background/main.ts` — Core task execution engine
- `src/sidebar/index.tsx` — User interface
- `public/instructions/domains/*.md` — Bundled domain instructions

## Limitations

- **No multi-browser automation** — Works within single browser instance
- **Limited to bundled instructions** — Other domains use LLM prior knowledge
- **No experience injection** — Standalone version doesn't use past execution traces
- **Execution traces only** — Results are local, not sent to a server

## License

MIT — See `LICENSE` file

---

This is the standalone version with no server dependencies.
