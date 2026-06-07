/**
 * Preset de catégories = les 8 phases du COMPANY_PLAYBOOK.md (+ juridique transverse).
 *
 * C'est de la DATA optionnelle, pas du couplage : le cœur du package reste agnostique.
 * La box (start-up-box) importe ce preset et le passe à `drainNotes({ categories })`,
 * pour qu'une note tombe dans la section de la bonne phase du BACKLOG.
 *
 * Un autre projet peut ignorer ce preset et fournir ses propres buckets.
 * Les `marker` correspondent aux titres de section attendus dans le BACKLOG.md.
 */
export const companyPhases = [
    {
        id: 'p0-cadrage',
        label: 'Phase 0 — Cadrage / idée',
        marker: '## Phase 0 — Cadrage / idée',
        keywords: ['idée', 'hypothèse', 'problème', 'cible pressentie', 'vision', 'intuition', 'pourquoi'],
    },
    {
        id: 'p1-validation',
        label: 'Phase 1 — Validation / discovery',
        marker: '## Phase 1 — Validation / discovery',
        keywords: ['interview', 'valider', 'validation', 'discovery', 'concurrent', 'concurrence', 'cible', 'segment', 'besoin', 'persona', 'fake door', 'sondage', 'marché'],
    },
    {
        id: 'p2-strategie',
        label: 'Phase 2 — Stratégie & business model',
        marker: '## Phase 2 — Stratégie & business model',
        keywords: ['business model', 'modèle éco', 'north star', 'kpi', 'metric', 'metrics', 'unit economics', 'marge', 'cac', 'ltv', 'runway', 'prévisionnel', 'business plan', 'rentabilité', 'subvention'],
    },
    {
        id: 'p3-marque-minimale',
        label: 'Phase 3 — Marque minimale',
        marker: '## Phase 3 — Marque minimale',
        keywords: ['plateforme', 'plateforme de marque', 'positionnement', 'guide éditorial', 'ton de voix', 'nom', 'naming', 'valeurs'],
    },
    {
        id: 'p4-offre-gtm',
        label: 'Phase 4 — Offre & go-to-market',
        marker: '## Phase 4 — Offre & go-to-market',
        keywords: ['prix', 'pricing', 'offre', 'packaging', 'palier', 'abonnement', 'freemium', 'landing', 'funnel', 'canal', 'acquisition', 'go-to-market', 'gtm', 'conversion', 'tarif', 'willingness to pay', 'pré-commande', 'landing test'],
    },
    {
        id: 'p5-identite',
        label: 'Phase 5 — Identité de marque complète',
        marker: '## Phase 5 — Identité de marque complète',
        keywords: ['marque', 'logo', 'charte', 'couleur', 'typo', 'typographie', 'manifesto', 'direction artistique', 'identité visuelle', 'personas', 'fondations'],
    },
    {
        id: 'p6-build',
        label: 'Phase 6 — Build / MVP',
        marker: '## Phase 6 — Build / MVP',
        keywords: ['build', 'mvp', 'feature', 'fonctionnalité', 'bug', 'code', 'dev', 'développement', 'api', 'base de données', 'dashboard', 'ui', 'ux', 'produit', 'tech'],
    },
    {
        id: 'p7-lancement',
        label: 'Phase 7 — Lancement',
        marker: '## Phase 7 — Lancement',
        keywords: ['lancement', 'launch', 'campagne', 'presse', 'post', 'social', 'email', 'newsletter', 'communication', 'annonce', 'tracking', 'analytics'],
    },
    {
        id: 'juridique',
        label: 'Juridique (transverse)',
        marker: '## Juridique (transverse)',
        keywords: ['juridique', 'statuts', 'rgpd', 'cgu', 'cgv', 'contrat', 'forme juridique', 'sas', 'sasu', 'assurance', 'mentions légales', 'siret', 'tva', 'avocat'],
    },
    {
        id: 'a-trier',
        label: 'À trier',
        marker: '## À trier',
        keywords: [],
        default: true,
    },
];

export default companyPhases;
