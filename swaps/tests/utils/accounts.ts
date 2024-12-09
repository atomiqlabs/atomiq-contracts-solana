import {workspace} from "@coral-xyz/anchor";
import { PublicKey, Signer, Keypair } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const TX_DATA_SEED = "data";

export const SwapVaultAuthority: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(AUTHORITY_SEED)],
    workspace.SwapProgram.programId
)[0];

export const RandomPDA: () => PublicKey = () => PublicKey.findProgramAddressSync(
    [randomBytes(32)],
    workspace.SwapProgram.programId
)[0];

export const SwapVault: (tokenAddress: PublicKey) => PublicKey = (tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), tokenAddress.toBuffer()],
    workspace.SwapProgram.programId
)[0];

export const SwapUserVault: (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey = (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), publicKey.toBuffer(), tokenAddress.toBuffer()],
    workspace.SwapProgram.programId
)[0];

export const SwapEscrowState: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
    [Buffer.from(STATE_SEED), hash],
    workspace.SwapProgram.programId
)[0];

export const SwapTxData: (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey = (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(TX_DATA_SEED), reversedTxId, pubkey.toBuffer()],
    workspace.SwapProgram.programId
)[0];

export const SwapTxDataAlt: (reversedTxId: Buffer, signer: Signer) => Signer = (reversedTxId: Buffer, signer: Signer) => {
    const buff = createHash("sha256").update(Buffer.concat([signer.secretKey, reversedTxId])).digest();
    return Keypair.fromSeed(buff);
};
