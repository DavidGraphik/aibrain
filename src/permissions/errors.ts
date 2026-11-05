export type PermissionErrorCode =
  | "PERMISSION_INVALID_REQUEST"
  | "PERMISSION_INSTALLATION_NOT_CONFIGURED"
  | "PERMISSION_AMBIGUOUS_INSTALLATION"
  | "PERMISSION_ROOT_UNAVAILABLE"
  | "PERMISSION_PATH_UNSAFE"
  | "PERMISSION_SYMLINK_REJECTED"
  | "PERMISSION_UNKNOWN_FORMAT"
  | "PERMISSION_AMBIGUOUS_POLICY"
  | "PERMISSION_POLICY_MISSING"
  | "PERMISSION_POLICY_NOT_READ_ONLY"
  | "PERMISSION_POLICY_TOO_LARGE"
  | "PERMISSION_POLICY_INVALID"
  | "PERMISSION_POLICY_DENIED"
  | "PERMISSION_POLICY_SCOPE_MISMATCH"
  | "PERMISSION_AUDIT_FAILED";

export class PermissionResolutionError extends Error {
  readonly code: PermissionErrorCode;
  readonly cause?: unknown;

  constructor(
    code: PermissionErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "PermissionResolutionError";
    this.code = code;
    this.cause = options.cause;
  }
}
