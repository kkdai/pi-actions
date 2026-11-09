/** Return true when the Unix-seconds token expiry has passed. */
export function isTokenExpired(expiresAtSeconds: number, nowMilliseconds: number): boolean {
  return expiresAtSeconds <= nowMilliseconds
}

/** Return the completed fraction, or zero when the batch is empty. */
export function completionRate(completed: number, total: number): number {
  return completed / total
}
