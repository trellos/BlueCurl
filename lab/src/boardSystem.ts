// Lab system: the procedural board (boardkit) on the board root, with anchor display.

import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Lab, LabSystem } from './app.ts';
import { Board } from './boardkit/board.ts';
import { SHORTBOARD_6_0, type BoardSpec } from './boardkit/spec.ts';
import { buildBoardObject, type BoardMeshOptions } from './boardkit/mesh.ts';

export class BoardSystem implements LabSystem {
  board: Board;
  object: THREE.Group;
  opts: BoardMeshOptions = { finish: 'sanded', wax: 1 };
  showAnchors = false;
  private anchorHelpers = new THREE.Group();
  private lab!: Lab;
  readonly listeners: Array<(b: Board) => void> = [];

  constructor(spec: BoardSpec = SHORTBOARD_6_0) {
    this.board = new Board(spec);
    this.object = buildBoardObject(this.board, this.opts);
  }

  init(lab: Lab): void {
    this.lab = lab;
    lab.boardRoot.add(this.object);
    lab.boardRoot.add(this.anchorHelpers);
    this.buildAnchorHelpers();
  }

  rebuild(): void {
    this.lab.boardRoot.remove(this.object);
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.MeshPhysicalMaterial;
        for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.clearcoatMap]) t?.dispose();
        mat.dispose();
      }
    });
    this.board = new Board(this.board.spec);
    this.object = buildBoardObject(this.board, this.opts);
    this.lab.boardRoot.add(this.object);
    this.buildAnchorHelpers();
    for (const l of this.listeners) l(this.board);
  }

  private buildAnchorHelpers(): void {
    this.anchorHelpers.clear();
    for (const a of this.board.anchors()) {
      const h = new THREE.AxesHelper(a.name.startsWith('ANC_foot') ? 0.12 : 0.05);
      h.position.copy(a.position);
      h.quaternion.copy(a.quaternion);
      (h.material as THREE.Material).depthTest = false;
      h.renderOrder = 10;
      this.anchorHelpers.add(h);
    }
    this.anchorHelpers.visible = this.showAnchors;
  }

  gui(lab: Lab, gui: GUI): void {
    const f = gui.addFolder('Board (boardkit)').close();
    const info = { volume: `${this.board.derived.volumeL.toFixed(1)} L`, length: `${(this.board.L / 0.3048).toFixed(2)} ft` };
    f.add(info, 'volume').disable();
    f.add(info, 'length').disable();
    f.add(this.opts, 'finish', ['sanded', 'gloss']).onChange(() => this.rebuild());
    f.add(this.opts, 'wax', 0, 1, 0.05).onFinishChange(() => this.rebuild());
    f.add(this, 'showAnchors').name('show anchors').onChange((v: boolean) => (this.anchorHelpers.visible = v));
    void lab;
  }
}
