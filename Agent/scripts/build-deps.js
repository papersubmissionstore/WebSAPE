/**
 * Build workspace dependencies required by the extension.
 *
 * Checks whether each dependency's dist/ output exists and is up-to-date
 * relative to its source files. Rebuilds automatically when:
 *   - The dist/ folder is missing entirely
 *   - Any source file is newer than the dist output
 *
 * Dependencies handled:
 *   1. @eko-ai/eko          (eko-core)              – rollup build
 *   2. @eko-ai/eko-extension                        – rollup build
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the newest mtime (ms) among all files matching the given extensions under `dir`. */
function newestMtime(dir, extensions) {
  let newest = 0;
  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip node_modules / hidden dirs
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      newest = Math.max(newest, newestMtime(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** Return the oldest mtime (ms) among all files in `dir`, or 0 if dir doesn't exist. */
function oldestDistMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let oldest = Infinity;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) return 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      oldest = Math.min(oldest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
    }
  }
  return oldest === Infinity ? 0 : oldest;
}

function buildIfNeeded({ name, srcDir, distDir, srcExtensions, buildCmd, buildCwd, alwaysBuild }) {
  if (alwaysBuild) {
    console.log(`[build-deps] ${name}: always-build enabled – rebuilding…`);
  } else {
    const distExists = fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0;

    if (!distExists) {
      console.log(`[build-deps] ${name}: dist not found – building…`);
    } else {
      const srcTime = newestMtime(srcDir, srcExtensions);
      const distTime = oldestDistMtime(distDir);
      if (srcTime <= distTime) {
        console.log(`[build-deps] ${name}: dist is up-to-date – skipping.`);
        return;
      }
      console.log(`[build-deps] ${name}: source is newer than dist – rebuilding…`);
    }
  }

  execSync(buildCmd, { stdio: "inherit", shell: true, cwd: buildCwd });
  console.log(`[build-deps] ${name}: build complete.`);
}

// ── Dependency definitions ───────────────────────────────────────────────────

const extDir = __dirname.replace(/[\\/]scripts$/, "");

const deps = [
  {
    name: "@eko-ai/eko (eko-core)",
    srcDir: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-core/src"),
    distDir: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-core/dist"),
    srcExtensions: [".ts", ".tsx"],
    buildCmd: "pnpm run build",
    buildCwd: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-core"),
    alwaysBuild: true,
  },
  {
    name: "@eko-ai/eko-extension",
    srcDir: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-extension/src"),
    distDir: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-extension/dist"),
    srcExtensions: [".ts", ".tsx"],
    buildCmd: "pnpm run build",
    buildCwd: path.resolve(extDir, "./thirdparty/eko-patch/packages/eko-extension"),
    alwaysBuild: true,
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────

for (const dep of deps) {
  buildIfNeeded(dep);
}
