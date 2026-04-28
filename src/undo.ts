import type { Feature, Parameter, ParameterGroup } from './types';
import { state } from './state';
import { requestRender } from './render';
import { evaluateTimeline } from './features';
import { updateSelStatus, updateStats } from './ui';
import { markDirty } from './dirty';

type Snapshot = {
  selection: number[];
  nextId: number;
  parameters: Parameter[];
  parameterGroups: ParameterGroup[];
  features: Feature[];
};

const MAX_STACK = 100;

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function snapshot(): Snapshot {
  return {
    selection: [...state.selection],
    nextId: state.nextId,
    parameters: structuredClone(state.parameters),
    parameterGroups: structuredClone(state.parameterGroups),
    features: structuredClone(state.features),
  };
}

function restore(s: Snapshot): void {
  state.nextId = s.nextId;
  state.parameters = s.parameters;
  state.parameterGroups = s.parameterGroups ?? [];
  state.features = s.features;
  // Rebuild entities (and the stable id map) from the restored feature list.
  evaluateTimeline();
  state.selection = new Set(s.selection.filter(id => state.entities.some(e => e.id === id)));
  updateStats();
  updateSelStatus();
  requestRender();
}

/**
 * Capture the current state so the next mutation can be undone.
 * Clears the redo stack because a new branch of history starts here.
 *
 * Also flips the dirty flag on: every code path that mutates persisted state
 * already calls `pushUndo()`, so this is the single choke-point that keeps
 * the "•" indicator and the close-guard prompt in sync without having to
 * touch every tool individually.
 */
export function pushUndo(): void {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_STACK) undoStack.shift();
  redoStack = [];
  markDirty();
}

export function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snapshot());
  if (redoStack.length > MAX_STACK) redoStack.shift();
  restore(prev);
}

export function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  if (undoStack.length > MAX_STACK) undoStack.shift();
  restore(next);
}

/** Wipe history — e.g. after loading a new drawing. */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
}

export function canUndo(): boolean { return undoStack.length > 0; }
export function canRedo(): boolean { return redoStack.length > 0; }
