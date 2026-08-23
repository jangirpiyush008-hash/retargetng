import type { ConsentStatus } from './policy.js';

export interface ConsentState {
  consent_status: ConsentStatus;
  marketing_allowed: boolean;
  advertising_personalization_allowed: boolean;
  data_sharing_allowed: boolean;
  consent_updated_at: Date | null;
}
export interface ConsentPurposes { marketing?: boolean; advertising_personalization?: boolean; data_sharing?: boolean }
export type ConsentEventType = 'CONSENT_GRANTED' | 'CONSENT_REVOKED' | 'CONSENT_UPDATED';

export const INITIAL_CONSENT: ConsentState = {
  consent_status: 'UNKNOWN', marketing_allowed: false, advertising_personalization_allowed: false, data_sharing_allowed: false, consent_updated_at: null,
};

/**
 * Pure reducer: applies a consent event to the current derived state.
 * - GRANTED: listed purposes → true (unlisted → true as well when no purposes given)
 * - REVOKED: listed purposes → false (all when none given)
 * - UPDATED: purposes set exactly as given
 * consent_status reflects advertising consent: GRANTED / DENIED (explicit) / UNKNOWN.
 * Events older than the current consent_updated_at are ignored (out-of-order delivery).
 */
export function applyConsentEvent(current: ConsentState, ev: { type: ConsentEventType; purposes?: ConsentPurposes | null; occurredAt: Date }): ConsentState {
  if (current.consent_updated_at && ev.occurredAt < current.consent_updated_at) return current;
  const p = ev.purposes ?? {};
  const listed = Object.keys(p).length > 0;
  const next = { ...current, consent_updated_at: ev.occurredAt };
  const set = (k: keyof ConsentPurposes, v: boolean) => {
    if (k === 'marketing') next.marketing_allowed = v;
    if (k === 'advertising_personalization') next.advertising_personalization_allowed = v;
    if (k === 'data_sharing') next.data_sharing_allowed = v;
  };
  const all: (keyof ConsentPurposes)[] = ['marketing', 'advertising_personalization', 'data_sharing'];
  if (ev.type === 'CONSENT_GRANTED') {
    for (const k of all) if (!listed || p[k] !== undefined) set(k, listed ? Boolean(p[k]) : true);
  } else if (ev.type === 'CONSENT_REVOKED') {
    for (const k of all) if (!listed || p[k] !== undefined) set(k, false);
  } else {
    for (const k of all) if (p[k] !== undefined) set(k, Boolean(p[k]));
  }
  if (ev.type === 'CONSENT_REVOKED' && (!listed || p.advertising_personalization !== undefined)) next.consent_status = 'DENIED';
  else if (next.advertising_personalization_allowed) next.consent_status = 'GRANTED';
  else if (ev.type === 'CONSENT_GRANTED' || ev.type === 'CONSENT_UPDATED') {
    // explicit event that leaves advertising off = denial of advertising personalization
    next.consent_status = p.advertising_personalization === false ? 'DENIED' : current.consent_status === 'GRANTED' ? 'DENIED' : current.consent_status;
  }
  return next;
}
