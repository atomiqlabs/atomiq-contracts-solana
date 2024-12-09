import { Keypair, SystemProgram, PublicKey, SignatureResult, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, Ed25519Program } from "@solana/web3.js";
import { AnchorProvider, EventParser, Program, workspace, Event, IdlEvents } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import BN from "bn.js";
import nacl from "tweetnacl";
import { TokenMint, getNewMint } from "../utils/tokens";
import { RandomPDA, SwapEscrowState, SwapUserVault, SwapVault, SwapVaultAuthority } from "../utils/accounts";
import { Account, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { getInitializedUserData } from "../utils/userData";
import { randomBytes, createHash } from "crypto";
import { EscrowStateType, SwapData, SwapType, SwapTypeEnum, getInitializeDefaultDataNotPayIn, getInitializeDefaultDataPayIn, getInitializedEscrowState as _getInitializedEscrowState, initializeDefaultAmount, initializeExecuteNotPayIn, initializeExecutePayIn } from "../utils/escrowState";
import { BtcRelayMainState, btcRelayProgram } from "../btcrelay/accounts";
import { ParalelizedTest } from "../utils";
import { CombinedProgramErrorType, parseSwapProgramError } from "../utils/program";

const BLOCKHEIGHT_EXPIRY_THRESHOLD = new BN(1000000000);
const MOCKED_BLOCKHEIGHT = 845414; //Mocked blockheight in BTC relay program
const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();
const eventParser = new EventParser(program.programId, program.coder);

type RefundIXData = RefundIXDataNotPayIn | RefundIXDataPayIn;
type RefundIXDataNotPayIn = {
    params: RefundIXParams,
    accounts: RefundIXAccountsNotPayIn,
    authSignature: {
        signature: Buffer,
        data: Buffer,
        signer: PublicKey
    },
    blockheightLock: {
        blockheight: BN,
        operator: number
    }
};
type RefundIXDataPayIn = {
    params: RefundIXParams,
    accounts: RefundIXAccountsPayIn,
    authSignature: {
        signature: Buffer,
        data: Buffer,
        signer: PublicKey
    },
    blockheightLock: {
        blockheight: BN,
        operator: number
    }
};

type RefundIXParams = {
    authExpiry: BN
};

type RefundIXAccounts = {
    offerer: Keypair,
    claimer: Keypair,
    escrowState: PublicKey,
    claimerUserData?: PublicKey,
    ixSysvar?: PublicKey,
};
type RefundIXAccountsNotPayIn = RefundIXAccounts & {
    offererUserData: PublicKey
};
type RefundIXAccountsPayIn = RefundIXAccounts & {
    offererAta: PublicKey,
    vault: PublicKey,
    vaultAuthority: PublicKey,
    tokenProgram: PublicKey
};

function signRefund(signer: Keypair, data: SwapData, authExpiry: BN) {
    const authData = createHash("sha256").update(Buffer.concat([
        Buffer.from("refund", "ascii"),
        data.amount.toBuffer("le", 8),
        data.expiry.toBuffer("le", 8),
        data.sequence.toBuffer("le", 8),
        Buffer.from(data.hash),
        authExpiry.toBuffer("le", 8)
    ])).digest();

    const signature = Buffer.from(nacl.sign.detached(authData, signer.secretKey));

    return {
        data: authData,
        signature,
        signer: signer.publicKey
    }
}

export async function getRefundDefaultDataPayIn(
    escrowState: EscrowStateType,
    authExpiry: BN = new BN(0)
): Promise<RefundIXDataPayIn> {
    const params: RefundIXParams = {
        authExpiry
    };
    
    const accounts: RefundIXAccountsPayIn = {
        claimer: escrowState.claimer,
        offerer: escrowState.offerer,
        offererAta: escrowState.offererAta || escrowState.mint.getATA(escrowState.offerer.publicKey),
        escrowState: SwapEscrowState(Buffer.from(escrowState.data.hash)),
        vault: SwapVault(escrowState.mint.mint),
        vaultAuthority: SwapVaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
        claimerUserData: null,
        ixSysvar: null,
    }
    
    if(!escrowState.data.payOut) {
        accounts.claimerUserData = SwapUserVault(escrowState.claimer.publicKey, escrowState.mint.mint);
    }

    if(!authExpiry.isZero()) {
        accounts.ixSysvar = SYSVAR_INSTRUCTIONS_PUBKEY;
    }

    if(escrowState.data.expiry.lt(BLOCKHEIGHT_EXPIRY_THRESHOLD)) {
        accounts.ixSysvar = SYSVAR_INSTRUCTIONS_PUBKEY;
    }

    return {
        params,
        accounts,
        authSignature: authExpiry.isZero() ? null : signRefund(escrowState.claimer, escrowState.data, authExpiry),
        blockheightLock: escrowState.data.expiry.lt(BLOCKHEIGHT_EXPIRY_THRESHOLD) ? {
            blockheight: escrowState.data.expiry,
            operator: 2
        } : null
    };
}

export async function getRefundDefaultDataNotPayIn(
    escrowState: EscrowStateType,
    authExpiry: BN = new BN(0)
): Promise<RefundIXDataNotPayIn> {
    const params: RefundIXParams = {
        authExpiry
    };
    
    const accounts: RefundIXAccountsNotPayIn = {
        claimer: escrowState.claimer,
        offerer: escrowState.offerer,
        offererUserData: SwapUserVault(escrowState.offerer.publicKey, escrowState.mint.mint),
        escrowState: SwapEscrowState(Buffer.from(escrowState.data.hash)),
        claimerUserData: null,
        ixSysvar: null,
    }
    
    if(!escrowState.data.payOut) {
        accounts.claimerUserData = SwapUserVault(escrowState.claimer.publicKey, escrowState.mint.mint);
    }

    if(!authExpiry.isZero()) {
        accounts.ixSysvar = SYSVAR_INSTRUCTIONS_PUBKEY;
    }
    
    if(escrowState.data.expiry.lt(BLOCKHEIGHT_EXPIRY_THRESHOLD)) {
        accounts.ixSysvar = SYSVAR_INSTRUCTIONS_PUBKEY;
    }

    return {
        params,
        accounts,
        authSignature: authExpiry.isZero() ? null : signRefund(escrowState.claimer, escrowState.data, authExpiry),
        blockheightLock: escrowState.data.expiry.lt(BLOCKHEIGHT_EXPIRY_THRESHOLD) ? {
            blockheight: escrowState.data.expiry,
            operator: 2
        } : null
    };
}

export async function refundExecutePayIn(data: RefundIXDataPayIn): Promise<{result: SignatureResult, signature: string, error: CombinedProgramErrorType}> {
    
    const ix = await program.methods.offererRefundPayIn(
        data.params.authExpiry
    ).accounts({
        claimer: data.accounts.claimer.publicKey,
        offerer: data.accounts.offerer.publicKey,
        offererAta: data.accounts.offererAta,
        escrowState: data.accounts.escrowState,
        vault: data.accounts.vault,
        vaultAuthority: data.accounts.vaultAuthority,
        tokenProgram: data.accounts.tokenProgram,
        claimerUserData: data.accounts.claimerUserData,
        ixSysvar: data.accounts.ixSysvar
    }).instruction();

    const tx = new Transaction();

    if(data.authSignature!=null) {
        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: data.authSignature.data,
            publicKey: data.authSignature.signer.toBuffer(),
            signature: data.authSignature.signature
        }));
    }

    if(data.blockheightLock!=null) {
        tx.add(await btcRelayProgram.methods.blockHeight(data.blockheightLock.blockheight.toNumber(), data.blockheightLock.operator).accounts({
            signer: data.accounts.offerer.publicKey,
            mainState: BtcRelayMainState
        }).instruction());
    }

    tx.add(ix);

    tx.feePayer = data.accounts.offerer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.offerer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature);

    return {
        result: result.value,
        signature,
        error: parseSwapProgramError(tx.instructions.length-1, result.value.err)
    };

}

export async function refundExecuteNotPayIn(data: RefundIXDataNotPayIn): Promise<{result: SignatureResult, signature: string, error: CombinedProgramErrorType}> {

    const ix = await program.methods.offererRefund(
        data.params.authExpiry
    ).accounts({
        claimer: data.accounts.claimer.publicKey,
        offerer: data.accounts.offerer.publicKey,
        offererUserData: data.accounts.offererUserData,
        escrowState: data.accounts.escrowState,
        claimerUserData: data.accounts.claimerUserData,
        ixSysvar: data.accounts.ixSysvar
    }).instruction();

    const tx = new Transaction();

    if(data.authSignature!=null) {
        tx.add(Ed25519Program.createInstructionWithPublicKey({
            message: data.authSignature.data,
            publicKey: data.authSignature.signer.toBuffer(),
            signature: data.authSignature.signature
        }));
    }

    if(data.blockheightLock!=null) {
        tx.add(await btcRelayProgram.methods.blockHeight(data.blockheightLock.blockheight.toNumber(), data.blockheightLock.operator).accounts({
            signer: data.accounts.offerer.publicKey,
            mainState: BtcRelayMainState
        }).instruction());
    }

    tx.add(ix);

    tx.feePayer = data.accounts.offerer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.offerer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature);

    return {
        result: result.value,
        signature,
        error: parseSwapProgramError(tx.instructions.length-1, result.value.err)
    };

}

const parallelTest = new ParalelizedTest();

function runTestsWith(payIn: boolean, payOut: boolean, refundType: "signed" | "timestamp" | "blockheight") {
    const prefix = "[payIn:"+payIn+" payOut:"+payOut+" "+refundType+"] ";

    const getInitializedEscrowState = (
        _payIn: boolean = payIn,
        _payOut: boolean = payOut,
        kind: SwapType = "htlc", 
        expiry: number = refundType==="signed" ? undefined : refundType==="timestamp" ? Math.floor(Date.now()/1000)-3600 : MOCKED_BLOCKHEIGHT-42, 
        hash: Buffer = randomBytes(32), 
        amount: BN = initializeDefaultAmount, 
        confirmations: number = 0, 
        nonce: BN = kind==="chainNonced" ? new BN(Buffer.concat([new BN(Math.floor((Date.now()/1000)) - 700000000).toBuffer(), randomBytes(3)])) : new BN(0),
        sequence: BN = new BN(randomBytes(8)),
        txoHash: Buffer = randomBytes(32),
        securityDeposit: BN = new BN(Math.floor(Math.random()*50000)),
        claimerBounty: BN = new BN(Math.floor(Math.random()*50000))
    ) => {
        return _getInitializedEscrowState(_payIn, _payOut, kind, expiry, hash, amount, confirmations, nonce, sequence, txoHash, securityDeposit, claimerBounty);
    };
    const getRefundDefaultData: (
        escrowState: EscrowStateType
    ) => Promise<RefundIXData> = (
        escrowState: EscrowStateType
    ) => {
        return payIn ?
            getRefundDefaultDataPayIn(escrowState, refundType==="signed" ? new BN(Math.floor(Date.now()/1000) + 3600) : undefined) :
            getRefundDefaultDataNotPayIn(escrowState, refundType==="signed" ? new BN(Math.floor(Date.now()/1000) + 3600) : undefined);
    }
    const refundExecute: (data: RefundIXData) => Promise<{result: SignatureResult, signature: string, error: CombinedProgramErrorType}> = payIn ? refundExecutePayIn : refundExecuteNotPayIn;

    parallelTest.it(prefix+"Success refund", async () => {
        const escrowStateData = await getInitializedEscrowState();
        const data = await getRefundDefaultData(escrowStateData);
        
        const initialOffererLamports = await provider.connection.getBalance(data.accounts.offerer.publicKey);
        const initialClaimerLamports = await provider.connection.getBalance(data.accounts.claimer.publicKey);
        const pdaLamports = await provider.connection.getBalance(data.accounts.escrowState);

        const lamportsPerSignature = await provider.connection.getFeeCalculatorForBlockhash(await provider.connection.getLatestBlockhash().then(e => e.blockhash)).then(e => e.value.lamportsPerSignature);

        let initialOffererUserData;

        let initialOffererAtaBalance: BN;
        let initialVaultBalance: BN;

        let initialClaimerUserData;
        if(payIn) {
            initialOffererAtaBalance = await getAccount(provider.connection, (data as RefundIXDataPayIn).accounts.offererAta)
                .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
            initialVaultBalance = await getAccount(provider.connection, (data as RefundIXDataPayIn).accounts.vault)
                .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        } else {
            initialOffererUserData = await program.account.userAccount.fetchNullable((data as RefundIXDataNotPayIn).accounts.offererUserData);
        }

        if(!payOut) {
            initialClaimerUserData = await program.account.userAccount.fetchNullable(data.accounts.claimerUserData);
        }

        const {result, signature} = await refundExecute(data);
        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

        const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);
        assert(escrowState==null, "Escrow not deleted!");

        //Check balances
        if(payIn) {
            const postOffererAtaBalance = await getAccount(provider.connection, (data as RefundIXDataPayIn).accounts.offererAta)
                .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
            const postVaultBalance = await getAccount(provider.connection, (data as RefundIXDataPayIn).accounts.vault)
                .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
            
            assert(initialOffererAtaBalance.add(initializeDefaultAmount).eq(postOffererAtaBalance), "Offerer ATA balance error");
            assert(initialVaultBalance.sub(initializeDefaultAmount).eq(postVaultBalance), "Vault balance error");
        } else {
            const postOffererUserData = await program.account.userAccount.fetchNullable((data as RefundIXDataNotPayIn).accounts.offererUserData);
            assert(initialOffererUserData.amount.add(initializeDefaultAmount).eq(postOffererUserData.amount), "User data balance error");
        }

        //Check reputation was updated
        const kind = SwapTypeEnum.toNumber(escrowStateData.data.kind);
        if(!payOut) {
            const postClaimerUserData = await program.account.userAccount.fetchNullable(data.accounts.claimerUserData);
            if(refundType==="signed") {
                assert(initialClaimerUserData.coopCloseCount[kind].add(new BN(1)).eq(postClaimerUserData.coopCloseCount[kind]), "User reputation not updated: count!");
                assert(initialClaimerUserData.coopCloseVolume[kind].add(escrowStateData.data.amount).eq(postClaimerUserData.coopCloseVolume[kind]), "User reputation not updated: volume!");
            } else {
                assert(initialClaimerUserData.failCount[kind].add(new BN(1)).eq(postClaimerUserData.failCount[kind]), "User reputation not updated: count!");
                assert(initialClaimerUserData.failVolume[kind].add(escrowStateData.data.amount).eq(postClaimerUserData.failVolume[kind]), "User reputation not updated: volume!");
            }
        }

        //Check security deposit was distributed
        const postOffererLamports = await provider.connection.getBalance(data.accounts.offerer.publicKey);
        const postClaimerLamports = await provider.connection.getBalance(data.accounts.claimer.publicKey);

        const txFee = (refundType==="signed" ? 2 : 1)*lamportsPerSignature;

        if(payIn) {
            assert(initialOffererLamports+pdaLamports-txFee===postOffererLamports, "Invalid offerer lamport balance, expected: "+(initialOffererLamports+pdaLamports-txFee)+" got: "+postOffererLamports);
            assert(initialClaimerLamports===postClaimerLamports, "Invalid claimer lamport balance, expected: "+initialClaimerLamports+" got: "+postClaimerLamports);
        } else {
            let securityDeposit = refundType==="signed" ? 0 : escrowStateData.securityDeposit.toNumber();

            assert(initialOffererLamports+securityDeposit-txFee===postOffererLamports, "Invalid offerer lamport balance, expected: "+(initialOffererLamports+securityDeposit-txFee)+" got: "+postOffererLamports);
            assert(initialClaimerLamports+pdaLamports-securityDeposit===postClaimerLamports, "Invalid claimer lamport balance, expected: "+(initialClaimerLamports+pdaLamports-securityDeposit)+" got: "+postClaimerLamports);
        }
        //Check that event was emitted
        const tx = await provider.connection.getTransaction(signature, {
            commitment: "confirmed"
        });
        
        const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

        let eventFound = false;
        for(let event of parsedEvents) {
            if(event.name==="RefundEvent") {
                eventFound = true;

                const hash: Buffer = Buffer.from(event.data.hash as number[]);
                const sequence: BN = event.data.sequence as BN;
                
                assert(hash.equals(Buffer.from(escrowStateData.data.hash)), "Event: invalid hash!");
                assert(sequence.eq(escrowStateData.data.sequence), "Event: invalid sequence!");
                
            }
        }

        assert(eventFound, "Event: not emitted!");
    });

    parallelTest.it(prefix+"Wrong offerer", async () => {
        const escrowStateData = await getInitializedEscrowState();

        const data = await getRefundDefaultData(escrowStateData);
        
        const otherOfferer = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherOfferer.publicKey, 1000000000));

        data.accounts.offerer = otherOfferer;
        if(payIn) {
            (data as RefundIXDataPayIn).accounts.offererAta = await escrowStateData.mint.mintTo(otherOfferer.publicKey, initializeDefaultAmount);
        } else {
            (data as RefundIXDataNotPayIn).accounts.offererUserData = await getInitializedUserData(otherOfferer, escrowStateData.mint, initializeDefaultAmount);
        }

        const {result, signature, error} = await refundExecute(data);
        
        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong claimer", async () => {
        const escrowStateData = await getInitializedEscrowState();

        const data = await getRefundDefaultData(escrowStateData);
        
        const otherClaimer = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));

        data.accounts.claimer = otherClaimer;
        if(!payOut) {
            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, escrowStateData.mint, initializeDefaultAmount);
        }

        if(refundType==="signed") {
            data.authSignature = signRefund(otherClaimer, escrowStateData.data, new BN(Math.floor(Date.now()/1000) + 3600));
        }

        const {result, signature, error} = await refundExecute(data);
        
        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong offerer & claimer", async () => {
        const escrowStateData = await getInitializedEscrowState();

        const data = await getRefundDefaultData(escrowStateData);
        
        const otherOfferer = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherOfferer.publicKey, 1000000000));

        data.accounts.offerer = otherOfferer;
        if(payIn) {
            (data as RefundIXDataPayIn).accounts.offererAta = await escrowStateData.mint.mintTo(otherOfferer.publicKey, initializeDefaultAmount);
        } else {
            (data as RefundIXDataNotPayIn).accounts.offererUserData = await getInitializedUserData(otherOfferer, escrowStateData.mint, initializeDefaultAmount);
        }
        
        const otherClaimer = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));

        data.accounts.claimer = otherClaimer;
        if(!payOut) {
            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, escrowStateData.mint, initializeDefaultAmount);
        }
        
        if(refundType==="signed") {
            data.authSignature = signRefund(otherClaimer, escrowStateData.data, data.params.authExpiry);
        }

        const {result, signature, error} = await refundExecute(data);
        
        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong payIn", async () => {
        const escrowStateData = await getInitializedEscrowState(!payIn);

        const data = await getRefundDefaultData(escrowStateData);

        if(payIn) {
            (data as RefundIXDataPayIn).accounts.offererAta = await escrowStateData.mint.mintTo(escrowStateData.offerer.publicKey, initializeDefaultAmount);
        } else {
            (data as RefundIXDataNotPayIn).accounts.offererUserData = await getInitializedUserData(escrowStateData.offerer, escrowStateData.mint, initializeDefaultAmount);
        }

        const {result, signature, error} = await refundExecute(data);
        
        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    if(payOut) {
        
        parallelTest.it(prefix+"ClaimerUserAccount of other signer", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            const otherClaimer = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));

            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, escrowStateData.mint, initializeDefaultAmount);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"ClaimerUserAccount of other mint", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            const otherMint = await getNewMint();
            data.accounts.claimerUserData = await getInitializedUserData(escrowStateData.claimer, otherMint, initializeDefaultAmount);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"ClaimerUserAccount of other signer & mint", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            const otherClaimer = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));
            const otherMint = await getNewMint();
            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, otherMint, initializeDefaultAmount);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(refundType==="signed") {

        parallelTest.it(prefix+"Wrong IX sysvar", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.accounts.ixSysvar = Keypair.generate().publicKey;

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="ConstraintAddress", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Expired auth", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.params.authExpiry = new BN(Math.floor(Date.now()/1000)-3600)
            data.authSignature = signRefund(data.accounts.claimer, escrowStateData.data, data.params.authExpiry);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="AuthExpired", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"No prior signature verify instruction", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.authSignature = null;

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="SignatureVerificationFailedInvalidProgram", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong data in signature verify instruction", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            escrowStateData.data.amount = new BN(randomBytes(8));
            escrowStateData.data.hash = [...randomBytes(32)];
            data.authSignature = signRefund(data.accounts.claimer, escrowStateData.data, data.params.authExpiry);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="SignatureVerificationFailedInvalidData", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong signer in signature verify instruction", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            const otherClaimer = Keypair.generate();
            data.authSignature = signRefund(otherClaimer, escrowStateData.data, data.params.authExpiry);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="SignatureVerificationFailedInvalidData", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });
        
    }

    if(refundType==="blockheight") {

        parallelTest.it(prefix+"Not expired yet", async () => {
            const escrowStateData = await getInitializedEscrowState(undefined, undefined, undefined, MOCKED_BLOCKHEIGHT+21);
            
            const data = await getRefundDefaultData(escrowStateData);

            const {result, signature} = await refundExecute(data);
        
            assert((result.err as any)?.InstructionError[0]===0, "Invalid transaction error: "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"No prior blockheight verify instruction", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.blockheightLock = null;

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="InvalidBlockheightVerifyProgramId", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Invalid blockheight verify instruction (blockheight)", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.blockheightLock.blockheight = new BN(MOCKED_BLOCKHEIGHT-4784);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="InvalidBlockheightVerifyHeight", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Invalid blockheight verify instruction (operator)", async () => {
            const escrowStateData = await getInitializedEscrowState();
            
            const data = await getRefundDefaultData(escrowStateData);

            data.blockheightLock.operator = 3;

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="InvalidBlockheightVerifyOperation", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(refundType==="timestamp") {

        parallelTest.it(prefix+"Not expired yet", async () => {
            const escrowStateData = await getInitializedEscrowState(undefined, undefined, undefined, Math.floor(Date.now()/1000)+3600);
            
            const data = await getRefundDefaultData(escrowStateData);

            const {result, signature, error} = await refundExecute(data);
        
            assert(error==="NotExpiredYet", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

}

describe("swap-program: Refund", () => {

    const payInVariants = [false, true];
    const payOutVariants = [false, true];
    const refundTypes: ("signed" | "timestamp" | "blockheight")[] = ["signed", "timestamp", "blockheight"];

    for(let payIn of payInVariants) {
        for(let payOut of payOutVariants) {
            for(let refundType of refundTypes) {
                runTestsWith(payIn, payOut, refundType);
            }
        }
    }

    parallelTest.execute();

});