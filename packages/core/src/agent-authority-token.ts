export type LaunchTextValidationErrorCode = "raw_authority_token_present";

export type LaunchTextValidationContext = {
  component: string;
  fieldPath?: string | undefined;
};

export class LaunchTextValidationError extends Error {
  readonly code: LaunchTextValidationErrorCode;
  readonly component: string;
  readonly fieldPath: string | undefined;

  constructor(code: LaunchTextValidationErrorCode, context: LaunchTextValidationContext) {
    super(`${code}:${context.component}`);
    this.name = "LaunchTextValidationError";
    this.code = code;
    this.component = context.component;
    this.fieldPath = context.fieldPath;
  }
}

const RAW_AGENT_AUTHORITY_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bcitadel_agent_authority_[A-Za-z0-9_-]{16,}\b/i,
  /\bcitadel_authority_[A-Za-z0-9_-]{16,}\b/i,
  /\bcitadel-authority-[A-Za-z0-9_-]{16,}\b/i,
  /\bcitadel-at-[A-Za-z0-9_-]{16,}\b/i,
  /\bctdl_agent_auth_[A-Za-z0-9_-]{16,}\b/i,
  /\bctdl-at-[A-Za-z0-9_-]{16,}\b/i,
  /\bagent_tool_authority_[A-Za-z0-9_-]{16,}\b/i,
];

export function containsRawAgentAuthorityToken(value: string): boolean {
  return RAW_AGENT_AUTHORITY_TOKEN_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertNoRawAgentAuthorityToken(value: string, context: LaunchTextValidationContext): void {
  if (!containsRawAgentAuthorityToken(value)) return;
  throw new LaunchTextValidationError("raw_authority_token_present", context);
}
