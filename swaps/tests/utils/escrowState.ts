import { Keypair, SystemProgram, PublicKey, SignatureResult } from "@solana/web3.js";
import { AnchorProvider, EventParser, Program, workspace, Event, IdlEvents } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import BN, { min } from "bn.js";
import { TokenMint, getNewMint } from "../utils/tokens";
import { RandomPDA, SwapEscrowState, SwapUserVault, SwapVault, SwapVaultAuthority } from "../utils/accounts";
import { Account, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { getInitializedUserData } from "../utils/userData";
import { randomBytes } from "crypto";
import { CombinedProgramErrorType, parseSwapProgramError } from "./program";

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();
const eventParser = new EventParser(program.programId, program.coder);

export const initializeDefaultAmount = new BN(100);

export type SwapType = "htlc" | "chain" | "chainNonced" | "chainTxhash";

export class SwapTypeEnum {
    htlc?: Record<string, never>;
    chain?: Record<string, never>;
    chainNonced?: Record<string, never>;
    chainTxhash?: Record<string, never>;

    static toNumber(data: SwapTypeEnum): number {
        const text = Object.keys(data)[0];
        if(text==="htlc") return 0;
        if(text==="chain") return 1;
        if(text==="chainNonced") return 2;
        if(text==="chainTxhash") return 3;
        return null;
    }
};

export class SwapData {
    kind: SwapTypeEnum;
    confirmations: number;
    nonce: BN;
    hash: number[];
    payIn: boolean;
    payOut: boolean;
    amount: BN;
    expiry: BN;
    sequence: BN;

    static equals(a: SwapData, b: SwapData) {
        if(Object.keys(a.kind)[0]!==Object.keys(b.kind)[0]) return false;
        if(a.confirmations!=b.confirmations) return false;
        if(!a.nonce.eq(b.nonce)) return false;
        if(!Buffer.from(a.hash).equals(Buffer.from(b.hash))) return false;
        if(a.payIn!=b.payIn) return false;
        if(a.payOut!=b.payOut) return false;
        if(!a.amount.eq(b.amount)) return false;
        if(!a.expiry.eq(b.expiry)) return false;
        if(!a.sequence.eq(b.sequence)) return false;
        return true;
    }
}

export type EscrowStateType = {
    data: SwapData,
    offerer: Keypair,
    offererAta: PublicKey,
    claimer: Keypair,
    claimerAta: PublicKey,
    mint: TokenMint,
    claimerBounty: BN,
    securityDeposit: BN
}

export type InitializeIXData = InitializeIXDataNotPayIn | InitializeIXDataPayIn;
export type InitializeIXDataNotPayIn ={
    mintData: TokenMint,
    params: InitializeIXParamsNotPayIn,
    accounts: InitializeIXAccountsNotPayIn
};
export type InitializeIXDataPayIn = {
    mintData: TokenMint,
    params: InitializeIXParamsPayIn,
    accounts: InitializeIXAccountsPayIn
};

export type InitializeIXParams = {
    swapData: SwapData,
    txoHash: number[],
    authExpiry: BN
};
export type InitializeIXParamsNotPayIn = InitializeIXParams & {
    securityDeposit: BN,
    claimerBounty: BN,
};
export type InitializeIXParamsPayIn = InitializeIXParams;

export type InitializeIXAccounts = {
    claimer: Keypair,
    offerer: Keypair,
    escrowState: PublicKey,
    mint: PublicKey,
    systemProgram: PublicKey,
    claimerUserData?: PublicKey,
    claimerAta?: PublicKey,
};
export type InitializeIXAccountsNotPayIn = InitializeIXAccounts & {
    offererUserData: PublicKey
};
export type InitializeIXAccountsPayIn = InitializeIXAccounts & {
    offererAta: PublicKey,
    vault: PublicKey,
    vaultAuthority: PublicKey,
    tokenProgram: PublicKey
};

export async function getInitializeDefaultDataNotPayIn(
    payOut: boolean,
    noInitClaimer?: boolean,
    noInitOfferer?: boolean,
    kind: SwapType = "htlc", 
    expiry: number = Math.floor(Date.now()/1000) + 3600, 
    hash: Buffer = randomBytes(32), 
    amount: BN = initializeDefaultAmount, 
    confirmations: number = 0, 
    nonce: BN = kind==="chainNonced" ? new BN(Buffer.concat([new BN(Math.floor((Date.now()/1000)) - 700000000).toBuffer(), randomBytes(3)])) : new BN(0),
    sequence: BN = new BN(randomBytes(8)),
    txoHash: Buffer = randomBytes(32),
    securityDeposit: BN = new BN(Math.floor(Math.random()*50000)),
    claimerBounty: BN = new BN(Math.floor(Math.random()*50000))
): Promise<InitializeIXDataNotPayIn> {
    const params: InitializeIXParamsNotPayIn = {
        swapData: {
            kind: {[kind]: null},
            confirmations,
            nonce,
            hash: [...hash],
            payIn: false,
            payOut,
            amount,
            expiry: new BN(expiry),
            sequence
        },
        securityDeposit,
        claimerBounty,
        txoHash: [...txoHash],
        authExpiry: new BN(Math.floor(Date.now()/1000) + 3600)
    }

    const claimer = Keypair.generate();
    const offerer = Keypair.generate();
    const mintData = await getNewMint();
    const offererUserData = SwapUserVault(offerer.publicKey, mintData.mint);
    const escrowState = SwapEscrowState(hash);
    const mint = mintData.mint;
    const systemProgram = SystemProgram.programId;
    
    const accounts: InitializeIXAccountsNotPayIn = {
        claimer,
        offerer,
        offererUserData,
        escrowState,
        mint,
        systemProgram,
        claimerAta: null,
        claimerUserData: null
    }

    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(claimer.publicKey, 1000000000));
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(offerer.publicKey, 1000000000));

    if(!noInitOfferer) await getInitializedUserData(offerer, mintData, initializeDefaultAmount);

    if(payOut) {
        if(!noInitClaimer) {
            accounts.claimerAta = await mintData.mintTo(accounts.claimer.publicKey, initializeDefaultAmount)
        } else {
            accounts.claimerAta = await mintData.getATA(accounts.claimer.publicKey);
        }
    } else {
        if(!noInitClaimer) {
            accounts.claimerUserData = await getInitializedUserData(claimer, mintData, initializeDefaultAmount);
        } else {
            accounts.claimerUserData = SwapUserVault(claimer.publicKey, mintData.mint);
        }
    }

    return {
        params,
        accounts,
        mintData
    };
}

export async function getInitializeDefaultDataPayIn(
    payOut: boolean,
    noInitClaimer?: boolean,
    noInitOfferer?: boolean,
    kind: SwapType = "htlc", 
    expiry: number = Math.floor(Date.now()/1000) + 3600, 
    hash: Buffer = randomBytes(32), 
    amount: BN = initializeDefaultAmount, 
    confirmations: number = 0, 
    nonce: BN = kind==="chainNonced" ? new BN(Buffer.concat([new BN(Math.floor((Date.now()/1000)) - 700000000).toBuffer(), randomBytes(3)])) : new BN(0),
    sequence: BN = new BN(randomBytes(8)),
    txoHash: Buffer = randomBytes(32)
): Promise<InitializeIXDataPayIn> {
    const params: InitializeIXParamsPayIn = {
        swapData: {
            kind: {[kind]: null},
            confirmations,
            nonce,
            hash: [...hash],
            payIn: true,
            payOut,
            amount,
            expiry: new BN(expiry),
            sequence
        },
        txoHash: [...txoHash],
        authExpiry: new BN(Math.floor(Date.now()/1000) + 3600)
    }

    const claimer = Keypair.generate();
    const offerer = Keypair.generate();
    const mintData = await getNewMint();
    const offererAta = mintData.getATA(offerer.publicKey);
    const escrowState = SwapEscrowState(hash);
    const vault = SwapVault(mintData.mint);
    const vaultAuthority = SwapVaultAuthority;
    const tokenProgram = TOKEN_PROGRAM_ID;
    const mint = mintData.mint;
    const systemProgram = SystemProgram.programId;
    
    const accounts: InitializeIXAccountsPayIn = {
        claimer,
        offerer,
        offererAta,
        escrowState,
        mint,
        systemProgram,
        claimerAta: null,
        claimerUserData: null,
        vault,
        vaultAuthority,
        tokenProgram
    }

    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(claimer.publicKey, 1000000000));
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(offerer.publicKey, 1000000000));

    if(!noInitOfferer) await mintData.mintTo(offerer.publicKey, initializeDefaultAmount);

    if(payOut) {
        if(!noInitClaimer) {
            accounts.claimerAta = await mintData.mintTo(accounts.claimer.publicKey, initializeDefaultAmount)
        } else {
            accounts.claimerAta = await mintData.getATA(accounts.claimer.publicKey);
        }
    } else {
        if(!noInitClaimer) {
            accounts.claimerUserData = await getInitializedUserData(claimer, mintData, initializeDefaultAmount);
        } else {
            accounts.claimerUserData = SwapUserVault(claimer.publicKey, mintData.mint);
        }
    }

    return {
        params,
        accounts,
        mintData
    };
}

export async function initializeExecuteNotPayIn(data: InitializeIXDataNotPayIn): Promise<{result:SignatureResult, signature: string, error: CombinedProgramErrorType}> {
    
    const tx = await program.methods.offererInitialize(
        data.params.swapData as any,
        data.params.securityDeposit,
        data.params.claimerBounty,
        data.params.txoHash,
        data.params.authExpiry
    ).accounts({
        claimer: data.accounts.claimer.publicKey,
        offerer: data.accounts.offerer.publicKey,
        offererUserData: data.accounts.offererUserData,
        escrowState: data.accounts.escrowState,
        mint: data.accounts.mint,
        systemProgram: data.accounts.systemProgram,
        claimerUserData: data.accounts.claimerUserData,
        claimerAta: data.accounts.claimerAta,
    }).transaction();

    tx.feePayer = data.accounts.claimer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.claimer, data.accounts.offerer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: result.value,
        signature,
        error: parseSwapProgramError(0, result.value.err)
    };

}

export async function initializeExecutePayIn(data: InitializeIXDataPayIn): Promise<{result:SignatureResult, signature: string, error: CombinedProgramErrorType}> {
    
    const tx = await program.methods.offererInitializePayIn(
        data.params.swapData as any,
        data.params.txoHash,
        data.params.authExpiry
    ).accounts({
        claimer: data.accounts.claimer.publicKey,
        offerer: data.accounts.offerer.publicKey,
        offererAta: data.accounts.offererAta,
        escrowState: data.accounts.escrowState,
        vault: data.accounts.vault,
        vaultAuthority: data.accounts.vaultAuthority,
        tokenProgram: data.accounts.tokenProgram,
        mint: data.accounts.mint,
        systemProgram: data.accounts.systemProgram,
        claimerUserData: data.accounts.claimerUserData,
        claimerAta: data.accounts.claimerAta,
    }).transaction();

    tx.feePayer = data.accounts.offerer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.claimer, data.accounts.offerer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: result.value,
        signature,
        error: parseSwapProgramError(0, result.value.err)
    };

}

export async function getInitializedEscrowState(
    payIn: boolean,
    payOut: boolean,
    kind: SwapType = "htlc", 
    expiry: number = Math.floor(Date.now()/1000) + 3600, 
    hash: Buffer = randomBytes(32), 
    amount: BN = initializeDefaultAmount, 
    confirmations: number = 0, 
    nonce: BN = kind==="chainNonced" ? new BN(Buffer.concat([new BN(Math.floor((Date.now()/1000)) - 700000000).toBuffer(), randomBytes(3)])) : new BN(0),
    sequence: BN = new BN(randomBytes(8)),
    txoHash: Buffer = randomBytes(32),
    securityDeposit: BN = new BN(Math.floor(Math.random()*50000)),
    claimerBounty: BN = new BN(Math.floor(Math.random()*50000))
): Promise<EscrowStateType> {

    let escrowState: EscrowStateType;
    let txResult;
    if(payIn) {
        const data = await getInitializeDefaultDataPayIn(payOut, undefined, undefined, kind, expiry, hash, amount, confirmations, nonce, sequence, txoHash);
        escrowState = {
            data: data.params.swapData,
            offerer: data.accounts.offerer,
            offererAta: data.accounts.offererAta,
            claimer: data.accounts.claimer,
            claimerAta: data.accounts.claimerAta || PublicKey.default,
            mint: data.mintData,
            claimerBounty: new BN(0),
            securityDeposit: new BN(0)
        }
        const {result} = await initializeExecutePayIn(data);
        txResult = result;
    } else {
        const data = await getInitializeDefaultDataNotPayIn(payOut, undefined, undefined, kind, expiry, hash, amount, confirmations, nonce, sequence, txoHash, securityDeposit, claimerBounty);
        escrowState = {
            data: data.params.swapData,
            offerer: data.accounts.offerer,
            offererAta: PublicKey.default,
            claimer: data.accounts.claimer,
            claimerAta: data.accounts.claimerAta || PublicKey.default,
            mint: data.mintData,
            claimerBounty,
            securityDeposit
        }
        const {result} = await initializeExecuteNotPayIn(data);
        txResult = result;
    }

    assert(txResult.err==null, "getInitializedEscrowState(): Transaction error: "+JSON.stringify(txResult.err, null, 4));

    return escrowState;

}