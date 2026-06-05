declare const tabIdBrand: unique symbol;
export type TabId = number & { readonly [tabIdBrand]: true };

export interface CdpBridgeOptions {
  port?: number;
  connectAckTimeoutMs?: number;
}
