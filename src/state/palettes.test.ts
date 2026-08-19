/**
 * Sanity tests for the ported palette system. Runs under Node's test
 * runner, no `localStorage` available here — `loadUserPalettes`/
 * `saveUserPalettes` catch that and degrade gracefully (see palettes.ts),
 * so persistence itself isn't exercised, only the in-memory state
 * transitions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { usePalettes } from './palettes.ts';

describe('paletteGroups (fixed, curated)', () => {
  test('has more than one group and every group has a name and colors', () => {
    const groups = usePalettes.getState().paletteGroups;
    assert.ok(groups.length > 1);
    for (const g of groups) {
      assert.ok(g.name.length > 0);
      assert.ok(g.colors.length > 0);
    }
  });

  test('every color channel is within 0..1', () => {
    for (const g of usePalettes.getState().paletteGroups) {
      for (const c of g.colors) {
        for (const channel of [c.r, c.g, c.b]) {
          assert.ok(channel >= 0 && channel <= 1, `${g.name} has an out-of-range channel: ${channel}`);
        }
      }
    }
  });

  test('group names are unique', () => {
    const names = usePalettes.getState().paletteGroups.map((g) => g.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe('user palettes CRUD', () => {
  test('starts empty (no localStorage to load from here)', () => {
    assert.deepEqual(usePalettes.getState().userPalettes, []);
  });

  test('createUserPalette adds a palette with no colors', () => {
    usePalettes.getState().createUserPalette('My colors');
    const list = usePalettes.getState().userPalettes;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'My colors');
    assert.deepEqual(list[0].colors, []);
  });

  test('addColorToUserPalette appends to the right palette only', () => {
    const { createUserPalette, addColorToUserPalette } = usePalettes.getState();
    createUserPalette('A');
    createUserPalette('B');
    const [a, b] = usePalettes.getState().userPalettes.slice(-2);
    addColorToUserPalette(a.id, { r: 1, g: 0, b: 0 });
    const after = usePalettes.getState().userPalettes;
    const afterA = after.find((p) => p.id === a.id)!;
    const afterB = after.find((p) => p.id === b.id)!;
    assert.deepEqual(afterA.colors, [{ r: 1, g: 0, b: 0 }]);
    assert.deepEqual(afterB.colors, []);
  });

  test('removeColorFromUserPalette removes by index', () => {
    const { createUserPalette, addColorToUserPalette, removeColorFromUserPalette } = usePalettes.getState();
    createUserPalette('C');
    const created = usePalettes.getState().userPalettes.at(-1)!;
    addColorToUserPalette(created.id, { r: 1, g: 0, b: 0 });
    addColorToUserPalette(created.id, { r: 0, g: 1, b: 0 });
    removeColorFromUserPalette(created.id, 0);
    const after = usePalettes.getState().userPalettes.find((p) => p.id === created.id)!;
    assert.deepEqual(after.colors, [{ r: 0, g: 1, b: 0 }]);
  });

  test('renameUserPalette changes only the name', () => {
    const { createUserPalette, renameUserPalette } = usePalettes.getState();
    createUserPalette('Old name');
    const created = usePalettes.getState().userPalettes.at(-1)!;
    renameUserPalette(created.id, 'New name');
    const after = usePalettes.getState().userPalettes.find((p) => p.id === created.id)!;
    assert.equal(after.name, 'New name');
    assert.equal(after.id, created.id);
  });

  test('deleteUserPalette removes it and leaves the others', () => {
    const { createUserPalette, deleteUserPalette } = usePalettes.getState();
    const before = usePalettes.getState().userPalettes.length;
    createUserPalette('To delete');
    const created = usePalettes.getState().userPalettes.at(-1)!;
    deleteUserPalette(created.id);
    assert.equal(usePalettes.getState().userPalettes.length, before);
    assert.ok(!usePalettes.getState().userPalettes.some((p) => p.id === created.id));
  });
});
