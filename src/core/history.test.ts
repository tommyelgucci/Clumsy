import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { History, type Command } from './history.ts';

function spyCommand(label: string, cost = 0, layerId?: string): Command & { undoCalls: number; redoCalls: number } {
  const cmd = {
    label,
    cost,
    layerId,
    undoCalls: 0,
    redoCalls: 0,
    undo() {
      cmd.undoCalls++;
    },
    redo() {
      cmd.redoCalls++;
    },
  };
  return cmd;
}

describe('History', () => {
  test('starts empty: cannot undo or redo', () => {
    const h = new History();
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
  });

  test('push() records a command without running it', () => {
    const h = new History();
    const cmd = spyCommand('draw stroke');
    h.push(cmd);
    assert.equal(cmd.redoCalls, 0);
    assert.equal(h.canUndo, true);
    assert.equal(h.undoLabel, 'draw stroke');
  });

  test('run() executes redo() once and records it', () => {
    const h = new History();
    const cmd = spyCommand('capture frame');
    h.run(cmd);
    assert.equal(cmd.redoCalls, 1);
    assert.equal(h.canUndo, true);
  });

  test('undo() calls undo() and moves the command to the future', () => {
    const h = new History();
    const cmd = spyCommand('draw stroke');
    h.push(cmd);
    const undone = h.undo();
    assert.equal(undone, true);
    assert.equal(cmd.undoCalls, 1);
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, true);
  });

  test('undo() on an empty stack returns false and does nothing', () => {
    const h = new History();
    assert.equal(h.undo(), false);
  });

  test('redo() calls redo() again and moves the command back to the past', () => {
    const h = new History();
    const cmd = spyCommand('draw stroke');
    h.push(cmd);
    h.undo();
    const redone = h.redo();
    assert.equal(redone, true);
    assert.equal(cmd.redoCalls, 1); // push() never called redo(); only this redo() did
    assert.equal(h.canUndo, true);
    assert.equal(h.canRedo, false);
  });

  test('pushing a new command after undo() clears the future', () => {
    const h = new History();
    h.push(spyCommand('a'));
    h.undo();
    assert.equal(h.canRedo, true);
    h.push(spyCommand('b'));
    assert.equal(h.canRedo, false);
  });

  test('clear() empties both stacks', () => {
    const h = new History();
    h.push(spyCommand('a'));
    h.undo();
    h.clear();
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
  });

  test('undoLabel/redoLabel reflect the top of each stack', () => {
    const h = new History();
    h.push(spyCommand('first'));
    h.push(spyCommand('second'));
    assert.equal(h.undoLabel, 'second');
    h.undo();
    assert.equal(h.redoLabel, 'second');
    assert.equal(h.undoLabel, 'first');
  });

  test('subscribe() fires on push/undo/redo/clear, and its return value unsubscribes', () => {
    const h = new History();
    let calls = 0;
    const unsubscribe = h.subscribe(() => calls++);
    h.push(spyCommand('a'));
    h.undo();
    h.redo();
    h.clear();
    assert.equal(calls, 4);
    unsubscribe();
    h.push(spyCommand('b'));
    assert.equal(calls, 4);
  });

  test('trims the oldest steps once the byte budget is exceeded', () => {
    const h = new History();
    const big = 200 * 1024 * 1024;
    const first = spyCommand('first', big);
    const second = spyCommand('second', big); // together they exceed the 320MB budget
    h.push(first);
    h.push(second);
    // The oldest one gets dropped, but at least one step always survives.
    assert.equal(h.pastCommands.length, 1);
    assert.equal(h.pastCommands[0].label, 'second');
  });

  test('never drops the only remaining step, even over budget', () => {
    const h = new History();
    h.push(spyCommand('only', 400 * 1024 * 1024));
    assert.equal(h.pastCommands.length, 1);
  });

  describe('discardForLayer', () => {
    // Regression coverage for a Codex-caught bug: Engine.removeLayer
    // used to release a deleted layer's GPU surfaces while its prior
    // commands were still sitting in this same stack, their closures
    // still referencing that now-destroyed surface — a later undo/redo
    // reaching one of those commands could silently corrupt whatever
    // OTHER layer's surface WebGL had since recycled that texture name
    // for. discardForLayer is the fix: drop every command tied to a
    // layer id, from both stacks, the moment that layer is gone.

    test('drops matching commands from the past stack, keeps the rest, in order', () => {
      const h = new History();
      h.push(spyCommand('layer A stroke 1', 0, 'A'));
      h.push(spyCommand('layer B stroke', 0, 'B'));
      h.push(spyCommand('layer A stroke 2', 0, 'A'));
      h.discardForLayer('A');
      assert.deepEqual(h.pastCommands.map((c) => c.label), ['layer B stroke']);
    });

    test('also drops matching commands from the future (redo) stack', () => {
      const h = new History();
      const a = spyCommand('layer A edit', 0, 'A');
      const b = spyCommand('layer B edit', 0, 'B');
      h.push(a);
      h.push(b);
      h.undo();
      h.undo();
      assert.equal(h.canRedo, true);
      h.discardForLayer('A');
      // Only B's command is left to redo; A's is gone entirely.
      h.redo();
      assert.equal(b.redoCalls, 1);
      assert.equal(h.canRedo, false);
    });

    test('never calls undo/redo on a discarded command', () => {
      const h = new History();
      const doomed = spyCommand('layer A edit', 0, 'A');
      h.push(doomed);
      h.push(spyCommand('layer B edit', 0, 'B'));
      h.discardForLayer('A');
      while (h.canUndo) h.undo();
      assert.equal(doomed.undoCalls, 0);
    });

    test('untagged commands (layerId undefined) are never matched or dropped', () => {
      const h = new History();
      h.push(spyCommand('no particular layer'));
      h.discardForLayer('anything');
      assert.equal(h.pastCommands.length, 1);
    });

    test('a no-op discard (nothing tagged for that layer) does not notify subscribers', () => {
      const h = new History();
      h.push(spyCommand('layer B edit', 0, 'B'));
      let calls = 0;
      h.subscribe(() => calls++);
      h.discardForLayer('A');
      assert.equal(calls, 0);
      assert.equal(h.pastCommands.length, 1);
    });
  });
});
