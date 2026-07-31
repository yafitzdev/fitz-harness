export type ArtifactKind = "text" | "code" | "image" | "audio" | "video" | "pdf" | "binary";
export interface ArtifactRecord { id: string; sessionId: string; name: string; mimeType: string; kind: ArtifactKind; byteSize: number; sha256: string; createdAt: string; createdByUserId?: string; metadata: Readonly<Record<string, unknown>> }
