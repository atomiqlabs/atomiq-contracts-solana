import { Keypair, SystemProgram, PublicKey, SignatureResult, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, Ed25519Program } from "@solana/web3.js";
import { AnchorProvider, EventParser, Program, workspace, Event, IdlEvents } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import BN from "bn.js";
import nacl from "tweetnacl";
import { TokenMint, getNewMint } from "../utils/tokens";
import { Account, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { getInitializedUserData } from "../utils/userData";
import { randomBytes, createHash } from "crypto";
import { EscrowStateType, SwapData, SwapType, SwapTypeEnum, getInitializeDefaultDataNotPayIn, getInitializeDefaultDataPayIn, getInitializedEscrowState, initializeDefaultAmount, initializeExecuteNotPayIn, initializeExecutePayIn } from "../utils/escrowState";

import btcRelayIdl from "../btc_relay.json";

const provider: AnchorProvider = AnchorProvider.local();
export const btcRelayProgram = new Program(btcRelayIdl as any, btcRelayIdl.metadata.address, provider);

const MAIN_SEED = "state";
const FORK_SEED = "fork";
const HEADER_SEED = "header";

export const BtcRelayMainState: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(MAIN_SEED)],
    btcRelayProgram.programId
)[0];

export type BitcoinHeader = {
    version: number,
    reversedPrevBlockhash: Buffer,
    merkleRoot: Buffer,
    timestamp: number,
    nbits: number,
    nonce: number
}

export type CommittedHeader = {
    chainWork: Buffer,
    header: BitcoinHeader,
    lastDiffAdjustment: number,
    blockheight: number,
    prevBlocktimestamps: number[]
};