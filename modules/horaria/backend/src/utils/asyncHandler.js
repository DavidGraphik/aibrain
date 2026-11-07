// Wraps async route handlers so errors go to Express error handler instead of crashing
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
