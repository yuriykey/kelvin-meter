/**
 * Reference cards.
 *
 * Live mode's calibration is bound to one specific card, because the method
 * depends on the actual spectral reflectance of the patches being sampled.
 * A calibration fitted against a ColorChecker Passport is meaningless applied
 * to a SpyderCheckr, so the card is part of the profile identity and is never
 * inferred.
 *
 * Four patches are enough, and four is what the guide shows. They are chosen
 * to be spectrally distinct where it matters: a warm patch whose reflectance
 * rises towards long wavelengths, a cool patch that does the opposite, a
 * green patch for the tint axis, and a neutral to reference it against.
 */

export type PatchRole = 'warm' | 'cool' | 'green' | 'neutral';

export interface PatchSpec {
  readonly role: PatchRole;
  /** The patch's name on the physical card. */
  readonly patchName: string;
  /** Where on the card to find it, in words. */
  readonly location: string;
  /** Approximate sRGB rendering, used only to colour the on-screen guide. */
  readonly swatch: string;
}

export interface ReferenceCard {
  readonly id: string;
  readonly name: string;
  readonly patches: readonly PatchSpec[];
  readonly note: string;
}

export const REFERENCE_CARDS: readonly ReferenceCard[] = [
  {
    id: 'cc-classic',
    name: 'ColorChecker Classic / Mini',
    note: 'Rows numbered from the top, columns from the left, card in landscape.',
    patches: [
      { role: 'warm', patchName: 'Orange', location: 'row 2, column 1', swatch: '#d67e2c' },
      { role: 'cool', patchName: 'Cyan', location: 'row 3, column 6', swatch: '#009fce' },
      { role: 'green', patchName: 'Green', location: 'row 3, column 2', swatch: '#66a64f' },
      { role: 'neutral', patchName: 'Neutral 6.5', location: 'row 4, column 3', swatch: '#a0a0a0' },
    ],
  },
  {
    id: 'cc-passport',
    name: 'ColorChecker Passport (classic target)',
    note: 'Use the 24-patch classic target page, not the creative enhancement page.',
    patches: [
      { role: 'warm', patchName: 'Orange', location: 'row 2, column 1', swatch: '#d67e2c' },
      { role: 'cool', patchName: 'Cyan', location: 'row 3, column 6', swatch: '#009fce' },
      { role: 'green', patchName: 'Green', location: 'row 3, column 2', swatch: '#66a64f' },
      { role: 'neutral', patchName: 'Neutral 6.5', location: 'row 4, column 3', swatch: '#a0a0a0' },
    ],
  },
  {
    id: 'spydercheckr-24',
    name: 'SpyderCheckr 24',
    note: 'Card in landscape with the neutral ramp along the bottom row.',
    patches: [
      { role: 'warm', patchName: 'Orange', location: 'row 2, column 4', swatch: '#e1802f' },
      { role: 'cool', patchName: 'Cyan', location: 'row 2, column 1', swatch: '#0d8fc4' },
      { role: 'green', patchName: 'Green', location: 'row 1, column 4', swatch: '#61a95f' },
      { role: 'neutral', patchName: '50% grey', location: 'row 4, column 3', swatch: '#9d9d9d' },
    ],
  },
];

export function findCard(id: string | null): ReferenceCard | null {
  if (!id) return null;
  return REFERENCE_CARDS.find((card) => card.id === id) ?? null;
}

export const PATCH_ROLE_ORDER: readonly PatchRole[] = ['warm', 'cool', 'green', 'neutral'];

export function patchForRole(card: ReferenceCard, role: PatchRole): PatchSpec | null {
  return card.patches.find((patch) => patch.role === role) ?? null;
}
