/**
 * Minimal 3x3 / 3-vector linear algebra.
 *
 * Row-major: m[row * 3 + col].
 */

export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type Vec3 = readonly [number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3(values: readonly number[]): Mat3 {
  if (values.length !== 9) {
    throw new Error(`mat3 expects 9 values, received ${values.length}`);
  }
  return [
    values[0]!, values[1]!, values[2]!,
    values[3]!, values[4]!, values[5]!,
    values[6]!, values[7]!, values[8]!,
  ];
}

export function vec3(values: readonly number[]): Vec3 {
  if (values.length !== 3) {
    throw new Error(`vec3 expects 3 values, received ${values.length}`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

export function matMulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3 + 0]! * b[0 * 3 + c]! +
        a[r * 3 + 1]! * b[1 * 3 + c]! +
        a[r * 3 + 2]! * b[2 * 3 + c]!;
    }
  }
  return mat3(out);
}

export function matAddScaled(a: Mat3, wa: number, b: Mat3, wb: number): Mat3 {
  const out = new Array<number>(9);
  for (let i = 0; i < 9; i++) out[i] = a[i]! * wa + b[i]! * wb;
  return mat3(out);
}

export function determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Throws when the matrix is singular — callers surface that as a bad-file error. */
export function invert(m: Mat3): Mat3 {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Matrix is singular or near-singular and cannot be inverted');
  }
  const inv = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * inv,
    (m[2] * m[7] - m[1] * m[8]) * inv,
    (m[1] * m[5] - m[2] * m[4]) * inv,
    (m[5] * m[6] - m[3] * m[8]) * inv,
    (m[0] * m[8] - m[2] * m[6]) * inv,
    (m[2] * m[3] - m[0] * m[5]) * inv,
    (m[3] * m[7] - m[4] * m[6]) * inv,
    (m[1] * m[6] - m[0] * m[7]) * inv,
    (m[0] * m[4] - m[1] * m[3]) * inv,
  ];
}

export function diagonal(v: Vec3): Mat3 {
  return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
}
