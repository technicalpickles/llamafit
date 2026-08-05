export interface SystemMemoryState {
  totalGb: number;
  usedGb: number;
  wiredGb: number;
  compressorGb: number;
  unusedGb: number;
  swapTotalGb: number;
  swapUsedGb: number;
  swapFreeGb: number;
}

export interface SystemProbe {
  platform: string;
  read(): Promise<SystemMemoryState>;
  /** Raw command outputs keyed by command name, for diagnostics bundles. */
  describe(): Promise<Record<string, string>>;
}
