import type { EnvelopePreset } from '../config/schema.js';

/** A stored value unwrapped into player data plus whatever metadata the wrapper kept. */
export interface Unwrapped {
  data: unknown;
  meta: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** anthony0br/DocumentService envelope. */
function unwrapDocumentService(value: unknown): Unwrapped {
  if (!isObject(value) || !('data' in value)) {
    throw new Error('value is not a DocumentService envelope (missing `data`)');
  }
  const meta: Record<string, unknown> = {};
  for (const k of ['dataSchemaVersion', 'documentServiceSchemaVersion', 'isLocked', 'lockTimestamp', 'sessionLockId', 'lastCompatibleVersion']) {
    if (k in value) meta[k] = value[k];
  }
  return { data: value.data, meta };
}

export function unwrap(preset: EnvelopePreset, value: unknown): Unwrapped {
  switch (preset) {
    case 'raw':
      return { data: value, meta: {} };
    case 'documentservice':
      return unwrapDocumentService(value);
  }
}

/** Best-effort detection, used by `pulse eval` when no config is given. */
export function detectEnvelope(value: unknown): EnvelopePreset {
  if (isObject(value) && 'data' in value && 'documentServiceSchemaVersion' in value) return 'documentservice';
  return 'raw';
}
