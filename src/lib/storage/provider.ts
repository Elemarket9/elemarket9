/**
 * Provider-neutral object storage contract.
 * Marketplace/domain code must depend on this interface, never on vendor storage APIs.
 */
export type StoragePurpose =
  | "product-image"
  | "profile-image"
  | "business-document"
  | "refund-evidence"
  | "order-attachment"
  | "financing-application-document";

export type UploadPolicy = {
  purpose: StoragePurpose;
  contentType: string;
  sizeBytes: number;
  extension?: string;
  resourceId?: string;
};

export type PresignedUpload = {
  key: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  requiredHeaders?: Record<string,string>;
};

export type StorageProvider = {
  createPresignedUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  createPresignedDownload(input: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<{ key: string; downloadUrl: string; expiresAt: string }>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  headObject(key: string): Promise<{ sizeBytes: number; contentType?: string | null }>;
  readObject(key: string, maxBytes: number): Promise<Uint8Array>;
};
