/**
 * DNG import: read a raw file the user picked, recover the illuminant the
 * camera measured at capture time.
 */

export * from './tags.ts';
export * from './tiff.ts';
export * from './parse.ts';
export * from './solve.ts';

import { DngParseError, parseDng, type DngMetadata } from './parse.ts';
import { DngSolveError, solveIlluminant, type SolveResult } from './solve.ts';
import { looksLikeTiff } from './tiff.ts';

export interface DngReading {
  readonly metadata: DngMetadata;
  readonly solve: SolveResult;
  readonly fileName: string;
  readonly fileSize: number;
}

/**
 * Read and solve a picked file. Everything stays in the browser: the bytes
 * go from the file input straight into an ArrayBuffer and are never sent
 * anywhere.
 */
export async function readDngFile(file: File): Promise<DngReading> {
  const buffer = await file.arrayBuffer();

  if (!looksLikeTiff(buffer)) {
    throw new DngParseError(
      `"${file.name}" is not a raw DNG. HEIC and JPEG files have already been ` +
        'white balanced, so the original light is no longer in them. Shoot in ' +
        'ProRAW or a DNG-capable camera app.',
    );
  }

  const metadata = parseDng(buffer);
  const solve = solveIlluminant(metadata);
  return { metadata, solve, fileName: file.name, fileSize: file.size };
}

export function describeDngError(error: unknown): string {
  if (error instanceof DngParseError || error instanceof DngSolveError) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'The file could not be read';
}
