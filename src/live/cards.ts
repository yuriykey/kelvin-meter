/**
 * Reference cards.
 *
 * Live mode's calibration is bound to one specific card, because the method
 * depends on the actual spectral reflectance of the patches being sampled. A
 * calibration fitted against a ColorChecker is meaningless applied to another
 * chart, so the card is part of the profile identity and is never inferred.
 *
 * Patch positions are stored as row and column numbers on the card, not as
 * prose, so the on-screen grid is generated from the same numbers the guide
 * text quotes. An earlier version described positions in words and laid the
 * guide boxes out in a straight line, which asked the user to line up four
 * patches that are not in a straight line on any card. That is not something
 * a person can do, and nothing in the code could notice.
 */

export type PatchRole = 'warm' | 'cool' | 'green' | 'neutral';

export interface PatchSpec {
  readonly role: PatchRole;
  /** The patch's name on the physical card. */
  readonly patchName: string;
  /** One short word for the label under the on-screen cell. */
  readonly shortName: string;
  /** 1-based row, counted from the top with the card held in landscape. */
  readonly row: number;
  /** 1-based column, counted from the left. */
  readonly column: number;
  /** Approximate sRGB rendering, used only to colour the on-screen guide. */
  readonly swatch: string;
}

export interface ReferenceCard {
  readonly id: string;
  readonly name: string;
  /** Grid size with the card held in landscape. */
  readonly rows: number;
  readonly columns: number;
  readonly patches: readonly PatchSpec[];
  readonly note: string;
}

/**
 * The four patches sampled from a 24-patch ColorChecker.
 *
 * They sit in one 2x3 block in the bottom-left corner rather than being spread
 * over the whole chart. That is deliberate: iOS varies its tone mapping across
 * the frame, and the ratio method only cancels the auto white balance gains if
 * both patches in a ratio got the same treatment. Patches that are neighbours
 * on the card are neighbours in the frame.
 *
 * Blue against Red gives the strongest possible red-versus-blue reflectance
 * contrast, which is exactly what the warmth feature needs, and Green against
 * a mid grey gives the green/magenta axis.
 */
const COLORCHECKER_PATCHES: readonly PatchSpec[] = [
  { role: 'cool', patchName: 'Blue', shortName: 'Blue', row: 3, column: 1, swatch: '#383d96' },
  { role: 'green', patchName: 'Green', shortName: 'Green', row: 3, column: 2, swatch: '#469449' },
  { role: 'warm', patchName: 'Red', shortName: 'Red', row: 3, column: 3, swatch: '#af363c' },
  {
    role: 'neutral',
    patchName: 'Neutral 6.5',
    shortName: 'Grey',
    row: 4,
    column: 3,
    swatch: '#a0a0a0',
  },
];

const COLORCHECKER_NOTE =
  'Hold the card in landscape, with the row of greys along the bottom and the white square at the bottom left. Fill the grid with the card.';

export const REFERENCE_CARDS: readonly ReferenceCard[] = [
  {
    id: 'cc-classic',
    name: 'ColorChecker Classic / Mini',
    rows: 4,
    columns: 6,
    patches: COLORCHECKER_PATCHES,
    note: COLORCHECKER_NOTE,
  },
  {
    id: 'cc-passport',
    name: 'ColorChecker Passport',
    rows: 4,
    columns: 6,
    patches: COLORCHECKER_PATCHES,
    note: `Use the 24-patch side, not the side with the warming and cooling patches. ${COLORCHECKER_NOTE}`,
  },
];

export function findCard(id: string | null): ReferenceCard | null {
  if (!id) return null;
  return REFERENCE_CARDS.find((card) => card.id === id) ?? null;
}

export function patchForRole(card: ReferenceCard, role: PatchRole): PatchSpec | null {
  return card.patches.find((patch) => patch.role === role) ?? null;
}

/** Human description of where a patch sits, generated from its coordinates. */
export function patchLocation(patch: PatchSpec): string {
  return `row ${patch.row}, column ${patch.column}`;
}
