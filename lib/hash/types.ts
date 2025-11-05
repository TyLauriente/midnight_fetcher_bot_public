export interface AshConfig {
  nbLoops: number;
  nbInstrs: number;
  pre_size: number;
  rom_size: number;
  mixing_numbers: number;
}

export const DEFAULT_ASH_CONFIG: AshConfig = {
  nbLoops: 8,
  nbInstrs: 256,
  pre_size: 16777216,
  rom_size: 1073741824,
  mixing_numbers: 4,
};

export interface HashEngineStatus {
  romInitialized: boolean;
  nativeAvailable: boolean;
  config: AshConfig | null;
  no_pre_mine_first8: string | null;
  no_pre_mine_last8: string | null;
}
