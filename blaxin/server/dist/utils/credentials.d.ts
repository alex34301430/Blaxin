import { ProviderId } from '../types.js';
export declare const credentialStore: {
    save(providerId: ProviderId, apiKey: string): void;
    get(providerId: ProviderId): string | null;
    remove(providerId: ProviderId): void;
    has(providerId: ProviderId): boolean;
    maskKey(apiKey: string): string;
    getAll(): Record<string, {
        hasKey: boolean;
        maskedKey?: string;
    }>;
};
//# sourceMappingURL=credentials.d.ts.map