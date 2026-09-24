import { ActionResult, ChatSession, SerializedMessage } from '../types';
import { restoreTask } from './taskSchema';

export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const actions = [
  'click',
  'left_click',
  'right_click',
  'double_click',
  'mouse_move',
  'left_click_drag',
  'type',
  'key',
  'scroll',
  'wait',
  'screenshot',
  'none',
  'confirm',
  'plan',
  'done',
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid session object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 65536): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error('Invalid or oversized session text');
  return value;
}
function date(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error('Invalid session date');
  return result;
}
function coordinates(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    ![2, 4].includes(value.length) ||
    value.some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000,
    )
  ) {
    throw new Error('Invalid saved coordinates');
  }
  return [...value];
}
function action(value: unknown): ActionResult {
  const data = object(value),
    args = object(data.arguments);
  const name = text(data.action, 40);
  if (!actions.includes(name)) throw new Error('Invalid saved action');
  const result: ActionResult = { action: name, arguments: {} };
  for (const key of ['text', 'key', 'direction'] as const) {
    if (args[key] !== undefined) result.arguments[key] = text(args[key], 8192);
  }
  for (const key of [
    'coordinate',
    'start_coordinate',
    'end_coordinate',
  ] as const) {
    if (args[key] !== undefined) result.arguments[key] = coordinates(args[key]);
  }
  if (args.amount !== undefined) {
    if (typeof args.amount !== 'number' || !Number.isFinite(args.amount))
      throw new Error('Invalid saved scroll amount');
    result.arguments.amount = args.amount;
  }
  return result;
}
function message(value: unknown): SerializedMessage {
  const data = object(value);
  if (!['user', 'assistant', 'system'].includes(String(data.role)))
    throw new Error('Invalid message role');
  const result: SerializedMessage = {
    id: text(data.id, 200),
    role: data.role as SerializedMessage['role'],
    content: text(data.content),
    timestamp: date(data.timestamp),
  };
  if (data.task !== undefined) result.task = restoreTask(data.task);
  if (data.action !== undefined) result.action = action(data.action);
  if (data.thinking !== undefined) result.thinking = text(data.thinking);
  if (data.modelResponse !== undefined)
    result.modelResponse = text(data.modelResponse, 33000);
  for (const key of ['screenshot', 'zoomCrop'] as const) {
    if (data[key] !== undefined) {
      const image = text(data[key], 24 * 1024 * 1024);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image))
        throw new Error('Invalid saved image');
      result[key] = image;
    }
  }
  for (const key of [
    'zoomCropCoordinate',
    'zoomCropBox',
    'screenshotBox',
  ] as const) {
    if (
      data[key] !== undefined &&
      !(Array.isArray(data[key]) && data[key].length === 0)
    )
      result[key] = coordinates(data[key]);
  }
  if (data.stepNumber !== undefined) {
    if (!Number.isInteger(data.stepNumber) || Number(data.stepNumber) < 0)
      throw new Error('Invalid saved step');
    result.stepNumber = Number(data.stepNumber);
  }
  return result;
}

// Copy only supported data. Imported history cannot recreate executor permissions.
export function validateSession(value: unknown): ChatSession {
  const data = object(value);
  if (!Array.isArray(data.messages) || data.messages.length > 2000)
    throw new Error('Invalid or oversized session messages');
  return {
    id: text(data.id, 200),
    name: text(data.name, 500),
    createdAt: date(data.createdAt),
    updatedAt: date(data.updatedAt),
    messages: data.messages.map(message),
    ...(data.initialQuery === undefined
      ? {}
      : { initialQuery: text(data.initialQuery, 8192) }),
  };
}

export function parseSessionImport(content: string): ChatSession[] {
  if (new TextEncoder().encode(content).byteLength > MAX_IMPORT_BYTES)
    throw new Error('Session import must be 32 MB or smaller');
  const data: unknown = JSON.parse(content);
  if (!Array.isArray(data) || data.length > 100)
    throw new Error('Import must contain at most 100 sessions');
  return data.map((value) => ({
    ...validateSession(value),
    id: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  }));
}
