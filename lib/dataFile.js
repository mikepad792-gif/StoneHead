// lib/dataFile.js
// Shared JSON data-file loader that works under BOTH module systems:
//
//   - Netlify's esbuild bundles functions to CommonJS, where `__dirname` is
//     defined and `import.meta.url` compiles to undefined. (This is why the
//     createRequire(import.meta.url) pattern crashed every function at cold
//     start: createRequire(undefined) throws ERR_INVALID_ARG_VALUE.)
//   - Plain Node ESM (the check harnesses) has import.meta.url and no
//     __dirname.
//
// `typeof __dirname` is safe in ESM (typeof on an undeclared identifier
// doesn't throw), and the import.meta.url branch is never evaluated in the
// CJS bundle, so each environment only touches the global it actually has.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const moduleDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

/**
 * Load and parse a JSON file from the repo's data/ directory.
 * In the Lambda bundle, moduleDir is /var/task/api (or /var/task/lib in dev
 * bundles) and netlify.toml's included_files puts data/ alongside it, so
 * ../data resolves in every environment this code runs in.
 *
 * @param {string} name - filename inside data/, e.g. "strains.json"
 * @returns {any} parsed JSON
 */
export function loadDataFile(name) {
  return JSON.parse(
    fs.readFileSync(path.join(moduleDir, "../data", name), "utf-8")
  );
}
