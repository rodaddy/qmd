declare module "picomatch" {
  export type Matcher = (input: string) => boolean;
  /** The parts of a pattern: the literal leading path and the glob after it. */
  export type ScanResult = {
    base: string;
    glob: string;
    isGlob: boolean;
    negated: boolean;
  };
  function picomatch(
    pattern: string | string[],
    options?: Record<string, unknown>,
  ): Matcher;
  namespace picomatch {
    function scan(
      pattern: string,
      options?: Record<string, unknown>,
    ): ScanResult;
  }
  export default picomatch;
}
