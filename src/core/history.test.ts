import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { History, type Command } from './history.ts';

function spyCommand(label: string, cost = 0): Command & { undoCalls: number; redoCalls: number } {
  const cmd = {
    label,
    cost,
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
});
