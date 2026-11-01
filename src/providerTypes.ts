export interface ProviderVerification {
  by: string;
  at: string;
  expiresAt: string;
  evidence: string;
}

export interface ReviewProviderConfig {
  schemaVersion: 1;
  provider: 'mock' | 'bedrock';
  modelId: string;
  // Optional model identity used only for the count-tokens operation when the
  // review model's inference profile does not support it. Invoke always uses modelId.
  countTokensModelId?: string;
  region?: string;
  contextTokens: number;
  maxOutputTokens: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  timeoutMs: number;
  verification?: ProviderVerification;
}

export interface ProviderRequest {
  partitionId: string;
  phase: 'review' | 'repair';
  modelId: string;
  maxOutputTokens: number;
  system: string;
  user: string;
}

export interface ProviderReply {
  text: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ReviewProvider {
  config: ReviewProviderConfig;
  countTokens(request: ProviderRequest, artifactDirectory: string): Promise<number>;
  invoke(request: ProviderRequest, artifactDirectory: string): Promise<ProviderReply>;
}
