export class WorkbenchNotFoundError extends Error {}
export class WorkbenchConflictError extends Error {}
export class WorkbenchValidationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
  }
}
export class WorkbenchPersistenceError extends Error {}
