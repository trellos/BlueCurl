// BoardSpec v0 (subset of docs/research/03-surfboards.md §4.8). Storage in metres.
// Board frame: +Z nose, +Y deck normal, +X left rail (seen from the tail looking at the nose),
// origin on the stringer on the rocker-table plane at mid-length.

export interface BoardSpec {
  schema: 'bluecurl.boardspec/1';
  id: string;
  type: 'shortboard' | 'fish' | 'mid' | 'longboard' | 'stepup' | 'gun';
  dims: { length: number; width: number; thickness: number; volumeL: number };
  outline: {
    /** Extra half-width knots as [distance from tail (m), full width (m)]. */
    widths: Array<[number, number]>;
    widePointFromCentre: number;
    noseTipRadius: number;
    tail: { type: 'squash' | 'round' | 'pin'; blockWidth: number; cornerRadius: number };
  };
  /** Bottom height at the stringer: [distance from tail (m), height (m)]. */
  rocker: Array<[number, number]>;
  /** Thickness: [distance from tail (m), thickness (m)]. */
  foil: Array<[number, number]>;
  deck: { dome: Array<[number, number]> };
  rails: {
    apexRatio: Array<[number, number]>;
    fullness: Array<[number, number]>;
    edgeRadius: Array<[number, number]>;
  };
  bottom: {
    contours: Array<{ type: 'single' | 'double' | 'vee'; u0: number; u1: number; depth: number; width?: number }>;
  };
  fins: {
    setup: 'thruster';
    list: Array<{
      id: string;
      /** Trailing edge of the base, distance from tail (m). */
      fromTail: number;
      /** Side fins: base trailing edge distance in from the rail edge (m). */
      fromRail?: number;
      toeDeg: number;
      cantDeg: number;
      template: 'M_side' | 'M_centre';
    }>;
  };
  plug: { fromTail: number };
  pad: { fromTail: number; length: number; kick: number; arch: number };
  stringer: { width: number };
  finish: { surface: 'sanded' | 'gloss' };
}

const IN = 0.0254;

/** 6'0" × 18¾" × 2⅜" thruster shortboard, ~28.5 L published. */
export const SHORTBOARD_6_0: BoardSpec = {
  schema: 'bluecurl.boardspec/1',
  id: 'sb_6-0_thruster_a',
  type: 'shortboard',
  dims: { length: 72 * IN, width: 18.75 * IN, thickness: 2.375 * IN, volumeL: 28.5 },
  outline: {
    // shaper-style widths (full width) measured from the tail
    widths: [
      [3 * IN, 11.0 * IN],
      [6 * IN, 12.7 * IN],
      [12 * IN, 14.0 * IN],
      [24 * IN, 17.3 * IN],
      [48 * IN, 17.0 * IN],
      [60 * IN, 11.5 * IN],
      [66 * IN, 7.6 * IN],
      [69 * IN, 4.6 * IN],
      [71 * IN, 1.9 * IN],
    ],
    widePointFromCentre: -0.02,
    noseTipRadius: 0.008,
    tail: { type: 'squash', blockWidth: 9.0 * IN, cornerRadius: 0.012 },
  },
  rocker: [
    [0, 0.057],
    [12 * IN, 0.024],
    [24 * IN, 0.007],
    [33 * IN, 0.0],
    [48 * IN, 0.012],
    [60 * IN, 0.048],
    [66 * IN, 0.082],
    [72 * IN, 0.127],
  ],
  foil: [
    [0, 0.02],
    [12 * IN, 0.041],
    [24 * IN, 0.0565],
    [35 * IN, 2.375 * IN],
    [48 * IN, 0.0575],
    [60 * IN, 0.042],
    [66 * IN, 0.029],
    [72 * IN, 0.012],
  ],
  deck: { dome: [[0, 0.2], [0.5, 0.45], [1, 0.3]] },
  rails: {
    apexRatio: [[0, 0.22], [0.5, 0.32], [1, 0.45]],
    fullness: [[0, 2.6], [0.5, 2.8], [1, 2.3]],
    edgeRadius: [[0, 0.0015], [0.35, 0.002], [0.6, 0.006], [1, 0.01]],
  },
  bottom: {
    contours: [
      { type: 'single', u0: 0.3, u1: 0.85, depth: 0.004, width: 0.75 },
      { type: 'double', u0: 0.0, u1: 0.3, depth: 0.003, width: 0.8 },
      { type: 'vee', u0: 0.0, u1: 0.12, depth: 0.002 },
    ],
  },
  fins: {
    setup: 'thruster',
    list: [
      { id: 'L1', fromTail: 0.286, fromRail: 0.029, toeDeg: 3, cantDeg: 6, template: 'M_side' },
      { id: 'R1', fromTail: 0.286, fromRail: 0.029, toeDeg: 3, cantDeg: 6, template: 'M_side' },
      { id: 'C', fromTail: 0.085, toeDeg: 0, cantDeg: 0, template: 'M_centre' },
    ],
  },
  plug: { fromTail: 0.1 },
  pad: { fromTail: 0.015, length: 0.31, kick: 0.025, arch: 0.007 },
  stringer: { width: 0.003 },
  finish: { surface: 'sanded' },
};
