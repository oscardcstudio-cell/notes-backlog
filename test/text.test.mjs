import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAccents, normalize, normalizeSpace, escapeRegExp, containsWord } from '../src/util/text.js';

test('stripAccents: retire les diacritiques', () => {
    assert.equal(stripAccents('éàùçôî'), 'eaucoi');
    assert.equal(stripAccents('déjà validé'), 'deja valide');
});

test('stripAccents: null/undefined → chaîne vide (pas de crash)', () => {
    assert.equal(stripAccents(null), '');
    assert.equal(stripAccents(undefined), '');
    assert.equal(stripAccents(123), '123');
});

test('normalize: sans accents + minuscules', () => {
    assert.equal(normalize('PriX éLevé'), 'prix eleve');
    assert.equal(normalize(''), '');
    assert.equal(normalize(null), '');
});

test('normalizeSpace: compacte les espaces multiples', () => {
    assert.equal(normalizeSpace('  Plan   B\tcomplet  '), 'plan b complet');
    assert.equal(normalizeSpace('A\n\nB'), 'a b');
});

test('escapeRegExp: échappe les métacaractères', () => {
    assert.equal(escapeRegExp('a.b*c+'), 'a\\.b\\*c\\+');
    assert.equal(escapeRegExp('(x)[y]{z}'), '\\(x\\)\\[y\\]\\{z\\}');
    assert.equal(escapeRegExp('plain'), 'plain');
});

test('escapeRegExp: la sortie est sûre comme littéral regex', () => {
    const needle = 'P4.0(special)';
    const re = new RegExp(escapeRegExp(needle));
    assert.equal(re.test('voir P4.0(special) ici'), true);
    assert.equal(re.test('voir P4X0special ici'), false);
});

test('containsWord: match sur frontière de mot, pas substring', () => {
    assert.equal(containsWord('phase p4 livree', 'p4'), true);
    // p4 collé à un alphanum de part/d'autre → pas de match (le bug que ça tue)
    assert.equal(containsWord('voir p40 plus loin', 'p4'), false);
    assert.equal(containsWord('voir sp4 plus loin', 'p4'), false);
});

test('containsWord: needle vide → false', () => {
    assert.equal(containsWord('whatever', ''), false);
});

test('containsWord: frontières incluent ponctuation/espaces', () => {
    assert.equal(containsWord('le mot, ici', 'mot'), true);
    assert.equal(containsWord('mot', 'mot'), true);
});
