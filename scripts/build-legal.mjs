#!/usr/bin/env node
// scripts/build-legal.mjs
// Renders docs/*.md into the static pages served at /privacy and /terms.
// Run: node scripts/build-legal.mjs
//
// WHY A GENERATOR AND NOT TWO HAND-WRITTEN HTML FILES
// The markdown in docs/ is the canonical text — it's what gets edited, quoted
// in Discord, and diffed in review. Hand-maintaining an HTML copy alongside it
// guarantees the two drift, and a privacy policy that describes behavior the
// app doesn't have is the exact bug class this batch already fixed once (the
// data toggle). One source, one command.
//
// Deliberately not a markdown library: this renders the small subset those two
// documents actually use, the input is ours rather than user-supplied, and a
// dependency that ships an HTML pipeline for two static pages is a worse trade
// than 80 lines here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PAGES = [
  { src: "docs/privacy-policy.md", out: "public/privacy.html", title: "Privacy Policy — Stone Head AI" },
  { src: "docs/terms-of-service.md", out: "public/terms.html", title: "Terms of Service — Stone Head AI" },
];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slug = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

/** Inline: links, bold, italic, code. Escaped first so markdown can't inject. */
function inline(text) {
  let t = esc(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
    const external = /^https?:/i.test(safe);
    return `<a href="${safe}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return t;
}

function render(md) {
  const lines = md.split("\n");
  const out = [];
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1].length;
      const text = heading[2];
      out.push(`<h${level} id="${slug(text.replace(/[*_`]/g, ""))}">${inline(text)}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushPara(); closeList();
      out.push("<hr />");
      continue;
    }

    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      flushPara();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }

    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList();
  return out.join("\n");
}

// Dark, readable, matches the app's palette. Self-contained — these pages must
// render for someone who is deciding whether to trust the app, which is not the
// moment for a webfont request to a third party.
const shell = (title, body) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#141412" />
    <title>${esc(title)}</title>
    <link rel="icon" href="/images/favicon.png" />
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; padding: 2rem 1.25rem 5rem;
        background: #141412; color: #e8e4dc;
        font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      main { max-width: 42rem; margin: 0 auto; }
      a { color: #9ec37d; }
      a:hover { color: #b8d99a; }
      h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 1.5rem; }
      h2 { font-size: 1.25rem; margin: 2.5rem 0 .75rem; color: #f3efe6; }
      h3 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; color: #f3efe6; }
      p, li { color: #ccc6ba; }
      li { margin: .35rem 0; }
      ul { padding-left: 1.25rem; }
      strong { color: #f3efe6; }
      hr { border: 0; border-top: 1px solid #2c2a26; margin: 2.5rem 0; }
      code { background: #1f1d1a; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
      .back { display: inline-block; margin-bottom: 2rem; font-size: .9rem; }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="/">&larr; back to Stone Head</a>
${body.split("\n").map((l) => "      " + l).join("\n")}
    </main>
  </body>
</html>
`;

for (const { src, out, title } of PAGES) {
  const md = fs.readFileSync(path.join(root, src), "utf8");
  fs.writeFileSync(path.join(root, out), shell(title, render(md)), "utf8");
  console.log(`  ${src} -> ${out}`);
}

console.log(
  "\nbuild-legal: done. docs/*.md is the source of truth — edit there and " +
  "re-run this, never edit public/privacy.html or public/terms.html directly."
);
