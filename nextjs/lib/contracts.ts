import SoulKeyABI from "./abi/SoulKey.json";
import VaultABI from "./abi/MasterKeyVault.json";

export const SOULKEY_CONTRACT = {
  address: process.env.NEXT_PUBLIC_SOULKEY_ADDRESS as `0x${string}`,
  abi: SoulKeyABI.abi,
} as const;

export const VAULT_CONTRACT = {
  address: process.env.NEXT_PUBLIC_VAULT_ADDRESS as `0x${string}`,
  abi: VaultABI.abi,
} as const;
