import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const INDEX_HTML = new URL("../index.html", import.meta.url);

function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1], match[2] ?? match[3] ?? ""]));
}

function ids(html) {
  return new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
}

test("document exposes a language, skip target, and named landmarks", async () => {
  const html = await readFile(INDEX_HTML, "utf8");
  assert.match(html, /<html\b[^>]*\blang=["'][a-z-]+["']/i);
  assert.match(html, /<meta\b[^>]*name=["']viewport["']/i);
  assert.match(html, /<a\b[^>]*class=["'][^"']*skip-link[^"']*["'][^>]*href=["']#main-content["']/i);
  assert.match(html, /<main\b[^>]*\bid=["']main-content["']/i);
  assert.match(html, /<aside\b[^>]*aria-label=["']Primary navigation["']/i);
  assert.match(html, /<div\b[^>]*role=["']status["'][^>]*aria-live=["']polite["']/i);
});

test("every dialog has a resolvable accessible name and description reference", async () => {
  const html = await readFile(INDEX_HTML, "utf8");
  const knownIds = ids(html);
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>/gi)].map((match) => attributes(match[1]));
  assert.ok(dialogs.length >= 5);
  dialogs.forEach((dialog) => {
    assert.ok(dialog.id, "dialog must have an id");
    assert.ok(dialog["aria-labelledby"], `${dialog.id} must reference a title`);
    dialog["aria-labelledby"].split(/\s+/).forEach((id) => assert.ok(knownIds.has(id), `${dialog.id} references missing title ${id}`));
    if (dialog["aria-describedby"]) dialog["aria-describedby"].split(/\s+/).forEach((id) => assert.ok(knownIds.has(id), `${dialog.id} references missing description ${id}`));
  });
});

test("internal fragment links resolve to an element in the page", async () => {
  const html = await readFile(INDEX_HTML, "utf8");
  const knownIds = ids(html);
  const fragments = [...html.matchAll(/<a\b[^>]*href=["']#([^"']+)["']/gi)].map((match) => match[1]);
  assert.ok(fragments.length >= 5);
  fragments.forEach((fragment) => assert.ok(knownIds.has(fragment), `fragment link #${fragment} has no target`));
});

test("programmatically triggered file inputs still have accessible names", async () => {
  const html = await readFile(INDEX_HTML, "utf8");
  for (const id of ["import-file", "dataset-file"]) {
    const match = html.match(new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`));
    assert.ok(match, `${id} must exist`);
    const input = attributes(match[0]);
    assert.equal(input.type, "file");
    assert.ok(input["aria-label"], `${id} needs an accessible label`);
  }
});
