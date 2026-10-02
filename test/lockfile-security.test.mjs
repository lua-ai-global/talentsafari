import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lockPath = process.env.LOCKFILE_UNDER_TEST || path.join(here, '..', 'package-lock.json');

const VULNERABLE = {
  'js-yaml': [['3.0.0', '3.15.2'], ['4.0.0', '4.3.2']],
  undici: [['6.25.0', '6.28.1'], ['7.28.0', '7.29.1'], ['8.1.0', '8.10.2']],
  '@ai-sdk/provider-utils': [[null, '3.0.28'], ['4.0.0-beta.10', '4.0.33'], ['5.0.0', '5.0.1']],
};

const ALLOWED_MAJORS = { 'js-yaml': [4], undici: [6], '@ai-sdk/provider-utils': [3] };

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  assert.ok(m, `unparseable version ${v}`);
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : null };
}

function comparePre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      if (+a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function compare(x, y) {
  const a = parse(x);
  const b = parse(y);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

function isVulnerable(name, version) {
  return VULNERABLE[name].some(
    ([lo, hi]) => (lo === null || compare(version, lo) >= 0) && compare(version, hi) < 0,
  );
}

function resolvedCopies(lock) {
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    for (const name of Object.keys(VULNERABLE)) {
      if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
        found.push({ name, key, version: entry.version });
      }
    }
  }
  return found;
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const copies = resolvedCopies(lock);

test('comparator flags boundary versions', () => {
  assert.equal(isVulnerable('js-yaml', '4.3.1'), true);
  assert.equal(isVulnerable('js-yaml', '4.3.2'), false);
  assert.equal(isVulnerable('undici', '6.28.0'), true);
  assert.equal(isVulnerable('undici', '6.28.1'), false);
  assert.equal(isVulnerable('@ai-sdk/provider-utils', '3.0.27'), true);
  assert.equal(isVulnerable('@ai-sdk/provider-utils', '3.0.28'), false);
  assert.equal(isVulnerable('@ai-sdk/provider-utils', '4.0.0-beta.10'), true);
  assert.equal(compare('4.0.0-beta.10', '4.0.0'), -1);
});

for (const name of Object.keys(VULNERABLE)) {
  test(`${name} is resolved in the lockfile`, () => {
    assert.ok(
      copies.some((c) => c.name === name),
      `no resolved ${name} found in ${lockPath}`,
    );
  });
}

test('no resolved copy is in a vulnerable range', () => {
  const bad = copies.filter((c) => isVulnerable(c.name, c.version));
  assert.deepEqual(
    bad.map((c) => `${lockPath}: ${c.key}@${c.version}`),
    [],
    'vulnerable versions resolved',
  );
});

test('every resolved copy stays on its allowed major line', () => {
  const off = copies.filter((c) => !ALLOWED_MAJORS[c.name].includes(parse(c.version).nums[0]));
  assert.deepEqual(
    off.map((c) => `${lockPath}: ${c.key}@${c.version}`),
    [],
    'copies off their major line',
  );
});
