/**
 * Utilitaires texte internes — factorisés depuis drain/categorize/coverage qui
 * dupliquaient stripAccents/normalize à l'identique. NON exporté publiquement
 * (absent de package.json#exports) : surface interne, libre de refactor.
 */

/** Retire les diacritiques (é → e) pour comparaison robuste. */
export function stripAccents(s) {
    return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalise pour comparaison : sans accents, minuscules. */
export function normalize(s) {
    return stripAccents(String(s ?? '')).toLowerCase();
}

/** Normalise + compacte les espaces (pour le matching de plan/titre). */
export function normalizeSpace(s) {
    return normalize(s).replace(/\s+/g, ' ').trim();
}

/** Échappe les métacaractères regex d'une chaîne (needle = data arbitraire). */
export function escapeRegExp(s) {
    return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `needle` présent dans `hay` sur des FRONTIÈRES de mot ?
 * `includes` brut sur-matche : un keyword court ("ui", "cac", "p4") matche
 * "build"/"cuisine"/"p40" → catégorisation/couverture faussées. On exige que le
 * match ne soit pas collé à un caractère alphanumérique de part et d'autre.
 * Les deux arguments doivent être déjà normalisés par l'appelant.
 * @param {string} hayNorm    chaîne normalisée à fouiller
 * @param {string} needleNorm aiguille normalisée
 */
export function containsWord(hayNorm, needleNorm) {
    if (!needleNorm) return false;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(needleNorm)}(?![a-z0-9])`);
    return re.test(hayNorm);
}
