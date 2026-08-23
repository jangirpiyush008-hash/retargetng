import type { DestinationAdapter, DestinationType } from './types.js';
import { MockGoogleAdapter, MockMetaAdapter, MockDestinationAdapter } from './adapters/mock.js';
import { MetaAdapter } from './adapters/meta.js';
import { GoogleAdsAdapter } from './adapters/google.js';

export type DestinationMode = 'mock' | 'live';

/**
 * Resolves adapters by destination type. In `mock` mode (DESTINATION_MODE=mock, the default)
 * META/GOOGLE_ADS resolve to the mock adapters so the full pipeline runs without sending any
 * customer data anywhere. Explicit MOCK_* types always resolve to mocks.
 */
export class DestinationRegistry {
  private instances = new Map<string, DestinationAdapter>();
  constructor(private mode: DestinationMode = (process.env.DESTINATION_MODE as DestinationMode) || 'mock') {}

  get(type: DestinationType): DestinationAdapter {
    const key = this.resolveKey(type);
    let a = this.instances.get(key);
    if (!a) { a = this.instantiate(key); this.instances.set(key, a); }
    return a;
  }
  private resolveKey(type: DestinationType): string {
    if (this.mode === 'mock' && type === 'META') return 'MOCK_META';
    if (this.mode === 'mock' && type === 'GOOGLE_ADS') return 'MOCK_GOOGLE';
    return type;
  }
  private instantiate(key: string): DestinationAdapter {
    switch (key) {
      case 'MOCK_META': return new MockMetaAdapter();
      case 'MOCK_GOOGLE': return new MockGoogleAdapter();
      case 'META': return new MetaAdapter();
      case 'GOOGLE_ADS': return new GoogleAdsAdapter();
      default: throw new Error(`No destination adapter registered for type ${key}`);
    }
  }
  /** Register a custom adapter (e.g. TikTok) at runtime. */
  register(type: string, adapter: DestinationAdapter) { this.instances.set(type, adapter); }
  isMock(type: DestinationType): boolean { return this.get(type) instanceof MockDestinationAdapter; }
  get currentMode() { return this.mode; }
}
export const DESTINATION_CATALOG = [
  { type: 'META', name: 'Meta Ads (Custom Audiences)', description: 'Facebook & Instagram — Custom Audiences from customer lists', identifierKinds: ['EMAIL', 'PHONE'] },
  { type: 'GOOGLE_ADS', name: 'Google Ads (Customer Match)', description: 'Search, YouTube, Display, Gmail — Customer Match via Data Manager API', identifierKinds: ['EMAIL', 'PHONE'] },
  { type: 'MOCK_META', name: 'Mock Meta (no data sent)', description: 'In-memory simulator for development and testing', identifierKinds: ['EMAIL', 'PHONE'] },
  { type: 'MOCK_GOOGLE', name: 'Mock Google (no data sent)', description: 'In-memory simulator for development and testing', identifierKinds: ['EMAIL', 'PHONE'] },
] as const;
