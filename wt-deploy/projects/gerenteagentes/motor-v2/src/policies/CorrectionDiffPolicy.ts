export function correctionOnlyChangesTests(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path))
}
