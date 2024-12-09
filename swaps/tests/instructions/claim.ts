import { Keypair, SystemProgram, PublicKey, SignatureResult, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, Ed25519Program, ComputeBudgetProgram } from "@solana/web3.js";
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
import { EscrowStateType, SwapData, SwapType, SwapTypeEnum, getInitializeDefaultDataPayIn, getInitializedEscrowState, initializeDefaultAmount } from "../utils/escrowState";
import { BtcRelayMainState, CommittedHeader, btcRelayProgram } from "../btcrelay/accounts";
import { ParalelizedTest } from "../utils";
import * as bitcoin from "bitcoinjs-lib";
import { AnchorErrorCodes, CombinedProgramErrorType, SwapProgramError, parseSwapProgramError } from "../utils/program";
import { getInitializedVault } from "../utils/vault";

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();
const eventParser = new EventParser(program.programId, program.coder);

const BIG_TX_NUM_INPUTS = 500;
const BIG_TX_NUM_OUTPUTS = 500;

function createRandomCommittedHeader(): CommittedHeader {
    return {
        chainWork: randomBytes(32),
        header: {
            version: 1,
            reversedPrevBlockhash: randomBytes(32),
            merkleRoot: randomBytes(32),
            timestamp: Math.floor(Date.now()/1000)-1800,
            nbits: 0x1703e8b3,
            nonce: 0x02382dce
        },
        lastDiffAdjustment: Math.floor(Date.now()/1000)-232183,
        blockheight: 857212,
        prevBlocktimestamps: [
            Math.floor(Date.now()/1000)-2002,
            Math.floor(Date.now()/1000)-4102,
            Math.floor(Date.now()/1000)-6802,
            Math.floor(Date.now()/1000)-9102,
            Math.floor(Date.now()/1000)-11032,
            Math.floor(Date.now()/1000)-12202,
            Math.floor(Date.now()/1000)-14002,
            Math.floor(Date.now()/1000)-16302,
            Math.floor(Date.now()/1000)-18002,
            Math.floor(Date.now()/1000)-19022,
        ]
    }
}

//Pay out can be: true, false
//Kind can be: htlc, chain, chainNonced, chainTxhash
//Claim type can be: ix, dataAccount

type ClaimIXData = ClaimIXDataNotPayOut | ClaimIXDataPayOut;
type ClaimIXDataNotPayOut = {
    params: ClaimIXParams,
    accounts: ClaimIXAccountsNotPayOut,
    escrowState: EscrowStateType,
    dataAccount?: {
        data: Buffer,
        signer: Keypair,
        address: Keypair
    },
    btcRelayVerify?: {
        reversedTxId: number[],
        confirmations: number,
        txIndex: number,
        reversedMerkleProof: number[][],
        committedHeader: CommittedHeader
    }
};
type ClaimIXDataPayOut = {
    params: ClaimIXParams,
    accounts: ClaimIXAccountsPayOut,
    escrowState: EscrowStateType,
    dataAccount?: {
        data: Buffer,
        signer: Keypair,
        address: Keypair
    },
    btcRelayVerify?: {
        reversedTxId: number[],
        confirmations: number,
        txIndex: number,
        reversedMerkleProof: number[][],
        committedHeader: CommittedHeader
    }
};

type ClaimIXParams = {
    secret?: number[]
};

type ClaimIXAccounts = {
    signer: Keypair,
    initializer: Keypair,
    escrowState: PublicKey,
    ixSysvar: PublicKey,
    data?: Keypair
};
type ClaimIXAccountsNotPayOut = ClaimIXAccounts & {
    claimerUserData: PublicKey
};
type ClaimIXAccountsPayOut = ClaimIXAccounts & {
    claimerAta: PublicKey,
    vault: PublicKey,
    vaultAuthority: PublicKey,
    tokenProgram: PublicKey
};

export async function getClaimDefaultData(
    payIn: boolean,
    payOut: boolean,
    kind: SwapType,
    claimWithAccount: boolean,
    swapNonce: BN = new BN(0),
    secret?: Buffer,
    hash?: Buffer,
    btcRelayVerify?: {
        reversedTxId: number[],
        confirmations: number,
        txIndex: number,
        reversedMerkleProof: number[][],
        committedHeader: CommittedHeader
    }
): Promise<ClaimIXDataPayOut | ClaimIXDataNotPayOut> {

    const confirmations = btcRelayVerify!=null ? btcRelayVerify.confirmations : 6;

    if(hash==null || secret==null) switch(kind) {
        case "htlc": {
            secret = randomBytes(32);
            hash = createHash("sha256").update(secret).digest();
            break;
        }
        case "chain": {
            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, 0, randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();

            btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            break;
        }
        case "chainNonced": {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            swapNonce = new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xF0000000).or(secondPart);

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = locktime.toNumber() + 500000000;
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();

            btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            break;
        }
        case "chainTxhash": {
            secret = Buffer.alloc(0);
            hash = randomBytes(32);

            btcRelayVerify = {
                reversedTxId: [...hash],
                confirmations: confirmations,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 2,
                committedHeader: createRandomCommittedHeader()
            }
            break;
        }
    }

    const escrowStateData = await getInitializedEscrowState(payIn, payOut, kind, undefined, hash, undefined, confirmations, swapNonce);

    const params: ClaimIXParams = {
        secret: claimWithAccount ? null : [...secret]
    };

    const signer = Keypair.generate();
    
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(signer.publicKey, 100000000000));

    const _accounts: ClaimIXAccounts = {
        signer: signer,
        initializer: payIn ? escrowStateData.offerer : escrowStateData.claimer,
        escrowState: SwapEscrowState(hash),
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        data: null
    }

    let dataAccount: {
        data: Buffer,
        signer: Keypair,
        address: Keypair
    };
    if(claimWithAccount) {
        const accountKey = Keypair.generate();
        dataAccount = {
            data: secret,
            signer,
            address: accountKey
        };
        _accounts.data = accountKey;
    }
    
    if(payOut) {
        const accounts = _accounts as ClaimIXAccountsPayOut;
        accounts.claimerAta = escrowStateData.claimerAta;
        accounts.vault = SwapVault(escrowStateData.mint.mint);
        accounts.vaultAuthority = SwapVaultAuthority;
        accounts.tokenProgram = TOKEN_PROGRAM_ID;

        return {
            params,
            accounts,
            escrowState: escrowStateData,
            dataAccount,
            btcRelayVerify
        };
    } else {
        const accounts = _accounts as ClaimIXAccountsNotPayOut;
        accounts.claimerUserData = SwapUserVault(escrowStateData.claimer.publicKey, escrowStateData.mint.mint);

        return {
            params,
            accounts,
            escrowState: escrowStateData,
            dataAccount,
            btcRelayVerify
        };
    }
}

export async function claimExecutePayOut(
    data: ClaimIXDataPayOut
): Promise<{result: SignatureResult, signature: string, signerPreBalance: number, error: CombinedProgramErrorType}> {

    let pdaReturningLamports = 0;
    if(data.dataAccount!=null) {
        //Create account
        const writeData = data.dataAccount.data;
        const dataSize = writeData.length;
        const accountSize = 32+dataSize;
        const lamports = await provider.connection.getMinimumBalanceForRentExemption(accountSize);
        pdaReturningLamports = lamports;

        const accCreateIx = SystemProgram.createAccount({
            fromPubkey: data.dataAccount.signer.publicKey,
            newAccountPubkey: data.dataAccount.address.publicKey,
            lamports,
            space: accountSize,
            programId: program.programId
        });

        const initIx = await program.methods.initData().accounts({
            signer: data.dataAccount.signer.publicKey,
            data: data.dataAccount.address.publicKey
        }).instruction();
        
        let pointer = 0;
        
        const writeLen = Math.min(writeData.length-pointer, 420);

        const _currentData = writeData.slice(pointer, pointer+writeLen);

        // console.log("Write data ("+pointer+".."+(pointer+writeLen)+"): ", _currentData.toString("hex"));

        const writeIx = await program.methods
            .writeData(pointer, _currentData)
            .accounts({
                signer: data.dataAccount.signer.publicKey,
                data: data.dataAccount.address.publicKey
            })
            .instruction();

        pointer += writeLen;

        const initTx = new Transaction();
        initTx.add(accCreateIx);
        initTx.add(initIx);
        initTx.add(writeIx);

        initTx.feePayer = data.dataAccount.signer.publicKey;

        const signature = await provider.connection.sendTransaction(initTx, [data.dataAccount.signer, data.dataAccount.address], {
            skipPreflight: true
        });
        const result = await provider.connection.confirmTransaction(signature);

        if(result.value.err!=null) throw new Error("Error during data account initialization: "+JSON.stringify(result.value.err, null, 4));

        const promises: Promise<SignatureResult>[] = [];

        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const currentData = writeData.slice(pointer, pointer+writeLen);

            // console.log("Write data ("+pointer+".."+(pointer+writeLen)+"): ", currentData);

            const writeTx = await program.methods
                .writeData(pointer, currentData)
                .accounts({
                    signer: data.dataAccount.signer.publicKey,
                    data: data.dataAccount.address.publicKey
                })
                .transaction();

            const signature = await provider.connection.sendTransaction(writeTx, [data.dataAccount.signer], {
                skipPreflight: true
            });
            promises.push(provider.connection.confirmTransaction(signature).then(e => e.value));

            pointer += writeLen;
        }

        const writeResults = await Promise.all(promises);

        writeResults.forEach(e => {
            if(e.err!=null) throw new Error("Error in write tx: "+JSON.stringify(e.err, null, 4));
        });
    }

    const ix = await program.methods.claimerClaimPayOut(
        Buffer.from(data.params.secret || [])
    ).accounts({
        signer: data.accounts.signer.publicKey,
        initializer: data.accounts.initializer.publicKey,
        escrowState: data.accounts.escrowState,
        ixSysvar: data.accounts.ixSysvar,
        claimerAta: data.accounts.claimerAta,
        vault: data.accounts.vault,
        vaultAuthority: data.accounts.vaultAuthority,
        tokenProgram: data.accounts.tokenProgram,
        data: data.accounts.data==null ? null : data.accounts.data.publicKey
    }).instruction();
    
    const tx = new Transaction();

    if(data.btcRelayVerify!=null) {
        tx.add(await btcRelayProgram.methods.verifyTransaction(
            Buffer.from(data.btcRelayVerify.reversedTxId),
            data.btcRelayVerify.confirmations,
            data.btcRelayVerify.txIndex,
            data.btcRelayVerify.reversedMerkleProof.map(e => Buffer.from(e)),
            data.btcRelayVerify.committedHeader
        ).accounts({
            signer: data.accounts.signer.publicKey,
            mainState: BtcRelayMainState
        }).instruction());
    }

    tx.add(ComputeBudgetProgram.setComputeUnitLimit({
        units: 1400000
    }));

    tx.add(ix);

    tx.feePayer = data.accounts.signer.publicKey;

    const signerPreBalance = await provider.connection.getBalance(data.accounts.signer.publicKey);

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: result.value,
        signature,
        signerPreBalance: signerPreBalance + pdaReturningLamports,
        error: parseSwapProgramError(tx.instructions.length-1, result.value.err)
    };

}

export async function claimExecuteNotPayOut(
    data: ClaimIXDataNotPayOut
): Promise<{result: SignatureResult, signature: string, signerPreBalance: number, error: CombinedProgramErrorType}> {

    let pdaReturningLamports = 0;
    if(data.dataAccount!=null) {
        //Create account
        const writeData = data.dataAccount.data;
        const dataSize = writeData.length;
        const accountSize = 32+dataSize;
        const lamports = await provider.connection.getMinimumBalanceForRentExemption(accountSize);
        pdaReturningLamports = lamports;

        const accCreateIx = SystemProgram.createAccount({
            fromPubkey: data.dataAccount.signer.publicKey,
            newAccountPubkey: data.dataAccount.address.publicKey,
            lamports,
            space: accountSize,
            programId: program.programId
        });

        const initIx = await program.methods.initData().accounts({
            signer: data.dataAccount.signer.publicKey,
            data: data.dataAccount.address.publicKey
        }).instruction();
        
        let pointer = 0;
        
        const writeLen = Math.min(writeData.length-pointer, 420);

        const _currentData = writeData.slice(pointer, pointer+writeLen);

        // console.log("Write data ("+pointer+".."+(pointer+writeLen)+"): ", _currentData.toString("hex"));

        const writeIx = await program.methods
            .writeData(pointer, _currentData)
            .accounts({
                signer: data.dataAccount.signer.publicKey,
                data: data.dataAccount.address.publicKey
            })
            .instruction();

        pointer += writeLen;

        const initTx = new Transaction();
        initTx.add(accCreateIx);
        initTx.add(initIx);
        initTx.add(writeIx);

        initTx.feePayer = data.dataAccount.signer.publicKey;

        const signature = await provider.connection.sendTransaction(initTx, [data.dataAccount.signer, data.dataAccount.address], {
            skipPreflight: true
        });
        const result = await provider.connection.confirmTransaction(signature);

        if(result.value.err!=null) throw new Error("Error during data account initialization: "+JSON.stringify(result.value.err, null, 4));

        const promises: Promise<SignatureResult>[] = [];

        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const currentData = writeData.slice(pointer, pointer+writeLen);

            // console.log("Write data ("+pointer+".."+(pointer+writeLen)+"): ", currentData);

            const writeTx = await program.methods
                .writeData(pointer, currentData)
                .accounts({
                    signer: data.dataAccount.signer.publicKey,
                    data: data.dataAccount.address.publicKey
                })
                .transaction();

            const signature = await provider.connection.sendTransaction(writeTx, [data.dataAccount.signer], {
                skipPreflight: true
            });
            promises.push(provider.connection.confirmTransaction(signature).then(e => e.value));

            pointer += writeLen;
        }

        const writeResults = await Promise.all(promises);

        writeResults.forEach(e => {
            if(e.err!=null) throw new Error("Error in write tx: "+JSON.stringify(e.err, null, 4));
        });
    }

    const ix = await program.methods.claimerClaim(
        Buffer.from(data.params.secret || [])
    ).accounts({
        signer: data.accounts.signer.publicKey,
        initializer: data.accounts.initializer.publicKey,
        escrowState: data.accounts.escrowState,
        ixSysvar: data.accounts.ixSysvar,
        claimerUserData: data.accounts.claimerUserData,
        data: data.accounts.data==null ? null : data.accounts.data.publicKey
    }).instruction();
    
    const tx = new Transaction();

    if(data.btcRelayVerify!=null) {
        tx.add(await btcRelayProgram.methods.verifyTransaction(
            Buffer.from(data.btcRelayVerify.reversedTxId),
            data.btcRelayVerify.confirmations,
            data.btcRelayVerify.txIndex,
            data.btcRelayVerify.reversedMerkleProof.map(e => Buffer.from(e)),
            data.btcRelayVerify.committedHeader
        ).accounts({
            signer: data.accounts.signer.publicKey,
            mainState: BtcRelayMainState
        }).instruction());
    }

    tx.add(ComputeBudgetProgram.setComputeUnitLimit({
        units: 1400000
    }));

    tx.add(ix);

    tx.feePayer = data.accounts.signer.publicKey;

    const signerPreBalance = await provider.connection.getBalance(data.accounts.signer.publicKey);

    const signature = await provider.connection.sendTransaction(tx, [data.accounts.signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: result.value,
        signature,
        signerPreBalance: signerPreBalance + pdaReturningLamports,
        error: parseSwapProgramError(tx.instructions.length-1, result.value.err)
    };

}

type ClaimInitialState = {
    initialOffererLamports: number,
    initialClaimerLamports: number,
    pdaLamports: number,
    lamportsPerSignature: number,
    initialClaimerUserData?: any,
    initialClaimerAtaBalance?: BN,
    initialVaultBalance?: BN
}

async function saveClaimInitialState(data: ClaimIXData): Promise<ClaimInitialState> {
    
    const initialOffererLamports = await provider.connection.getBalance(data.escrowState.offerer.publicKey);
    const initialClaimerLamports = await provider.connection.getBalance(data.escrowState.claimer.publicKey);
    const pdaLamports = await provider.connection.getBalance(data.accounts.escrowState);
    
    const lamportsPerSignature = await provider.connection.getFeeCalculatorForBlockhash(await provider.connection.getLatestBlockhash().then(e => e.blockhash)).then(e => e.value.lamportsPerSignature);

    let initialClaimerUserData;

    let initialClaimerAtaBalance: BN;
    let initialVaultBalance: BN;

    if(data.escrowState.data.payOut) {
        initialClaimerAtaBalance = await getAccount(provider.connection, (data as ClaimIXDataPayOut).accounts.claimerAta)
            .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        initialVaultBalance = await getAccount(provider.connection, (data as ClaimIXDataPayOut).accounts.vault)
            .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
    } else {
        initialClaimerUserData = await program.account.userAccount.fetchNullable((data as ClaimIXDataNotPayOut).accounts.claimerUserData);
    }

    return {
        initialOffererLamports,
        initialClaimerLamports,
        pdaLamports,
        lamportsPerSignature,
        initialClaimerUserData,
        initialClaimerAtaBalance,
        initialVaultBalance
    }

}

async function verifyClaimInvariants(data: ClaimIXData, initialState: ClaimInitialState, result: SignatureResult, signature: string, signerPreBalance: number): Promise<void> {

    const payOut = data.escrowState.data.payOut;
    const payIn = data.escrowState.data.payIn;
    const kind = data.escrowState.data.kind;

    assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));
        
    const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);
    assert(escrowState==null, "Escrow not deleted!");

    //Check balances
    if(payOut) {
        const postClaimerAtaBalance = await getAccount(provider.connection, (data as ClaimIXDataPayOut).accounts.claimerAta)
            .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postVaultBalance = await getAccount(provider.connection, (data as ClaimIXDataPayOut).accounts.vault)
            .catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        
        assert(initialState.initialClaimerAtaBalance.add(initializeDefaultAmount).eq(postClaimerAtaBalance), "Claimer ATA balance error");
        assert(initialState.initialVaultBalance.sub(initializeDefaultAmount).eq(postVaultBalance), "Vault balance error");
    } else {
        const postClaimerUserData = await program.account.userAccount.fetchNullable((data as ClaimIXDataNotPayOut).accounts.claimerUserData);
        assert(initialState.initialClaimerUserData.amount.add(initializeDefaultAmount).eq(postClaimerUserData.amount), "User data balance error");

        const kindNum = SwapTypeEnum.toNumber(kind);
        assert(initialState.initialClaimerUserData.successCount[kindNum].add(new BN(1)).eq(postClaimerUserData.successCount[kindNum]), "User reputation not updated: count!");
        assert(initialState.initialClaimerUserData.successVolume[kindNum].add(data.escrowState.data.amount).eq(postClaimerUserData.successVolume[kindNum]), "User reputation not updated: volume!");
    }
    
    const postOffererLamports = await provider.connection.getBalance(data.escrowState.offerer.publicKey);
    const postClaimerLamports = await provider.connection.getBalance(data.escrowState.claimer.publicKey);
    const postSignerLamports = await provider.connection.getBalance(data.accounts.signer.publicKey);

    if(payIn) {
        assert(initialState.initialOffererLamports+initialState.pdaLamports===postOffererLamports, "Invalid offerer lamport balance, expected: "+(initialState.initialOffererLamports+initialState.pdaLamports)+" got: "+postOffererLamports);
        assert(initialState.initialClaimerLamports===postClaimerLamports, "Invalid claimer lamport balance, expected: "+initialState.initialClaimerLamports+" got: "+postClaimerLamports);
    } else {
        const txFee = initialState.lamportsPerSignature;
        let claimerBounty = data.escrowState.claimerBounty.toNumber();

        assert(signerPreBalance+claimerBounty-txFee===postSignerLamports, "Invalid signer lamport balance, expected: "+(signerPreBalance+claimerBounty-txFee)+" got: "+postSignerLamports);
        assert(initialState.initialClaimerLamports+initialState.pdaLamports-claimerBounty===postClaimerLamports, "Invalid claimer lamport balance, expected: "+(initialState.initialClaimerLamports+initialState.pdaLamports-claimerBounty)+" got: "+postClaimerLamports);
    }
    
    //Check that event was emitted
    const tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed"
    });
    
    const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

    let eventFound = false;
    for(let event of parsedEvents) {
        if(event.name==="ClaimEvent") {
            eventFound = true;

            const hash: Buffer = Buffer.from(event.data.hash as number[]);
            const secret: Buffer = Buffer.from(event.data.secret as number[]);
            const sequence: BN = event.data.sequence as BN;
            
            assert(hash.equals(Buffer.from(data.escrowState.data.hash)), "Event: invalid hash!");
            assert(sequence.eq(data.escrowState.data.sequence), "Event: invalid sequence!");
            
            if(SwapTypeEnum.toNumber(kind)===0) { //HTLC
                assert(secret.equals(Buffer.from(data.params.secret || data.dataAccount.data).slice(0, 32)), "Event: invalid secret!");
            } else {
                assert(secret.equals(Buffer.from(data.btcRelayVerify.reversedTxId)), "Event: invalid secret!");
            }
        }
    }

    assert(eventFound, "Event: not emitted!");

}

const parallelTest = new ParalelizedTest();

function runTestsWith(payIn: boolean, payOut: boolean, kind: SwapType, claimWithAccount: boolean) {

    const prefix = "[payIn: "+payIn+" payOut: "+payOut+" kind: "+kind+" claimWithAccount: "+claimWithAccount+"] "

    const claimExecute: (data: ClaimIXData) => Promise<{result: SignatureResult, signature: string, signerPreBalance: number, error: CombinedProgramErrorType}> = payOut ? claimExecutePayOut : claimExecuteNotPayOut;

    parallelTest.it(prefix+"Initialize and claim", async () => {
        const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

        const initialState = await saveClaimInitialState(data);

        const {result, signature, signerPreBalance} = await claimExecute(data);

        await verifyClaimInvariants(data, initialState, result, signature, signerPreBalance);
    });

    if(kind==="htlc") {
        parallelTest.it(prefix+"HTLC claim with right padded gibberish", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

            const initialState = await saveClaimInitialState(data);

            const {result, signature, signerPreBalance} = await claimExecute(data);
    
            await verifyClaimInvariants(data, initialState, result, signature, signerPreBalance);
        });
    }

    if(kind==="chainTxhash") {
        parallelTest.it(prefix+"chainTxhash with gibberish data (should be ignored)", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

            const initialState = await saveClaimInitialState(data);

            const {result, signature, signerPreBalance} = await claimExecute(data);
    
            await verifyClaimInvariants(data, initialState, result, signature, signerPreBalance);
        });
    }

    
    if((kind==="chainNonced" || kind==="chain") && claimWithAccount) {
        parallelTest.it(prefix+"Big btc transaction", async () => {
            let firstPart = new BN(0);
            let secondPart = new BN(0);
            let swapNonce = new BN(0);
            if(kind==="chainNonced") {

                firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
                secondPart = new BN(randomBytes(3));
    
                const nonceBuffer = Buffer.concat([
                    Buffer.from(firstPart.toArray("be", 5)),
                    Buffer.from(secondPart.toArray("be", 3))
                ]);
        
                swapNonce = new BN(nonceBuffer, "be");
            }
            
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const btcTx = new bitcoin.Transaction();
            
            const locktime = firstPart;
            btcTx.locktime = locktime.toNumber() + 500000000;
            const nSequence = new BN(0xF0000000).or(secondPart);

            for(let i=0;i<BIG_TX_NUM_INPUTS;i++) {
                btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            }
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            for(let i=0;i<BIG_TX_NUM_OUTPUTS-1;i++) {
                const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
                btcTx.addOutput(changeAddress.output, new BN(randomBytes(3)).toNumber());
            }
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();

            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);

            const initialState = await saveClaimInitialState(data);

            const {result, signature, signerPreBalance} = await claimExecute(data);
    
            await verifyClaimInvariants(data, initialState, result, signature, signerPreBalance);
        });
    }

    parallelTest.it(prefix+"Wrong escrow_state (wrong data.pay_out)", async () => {
        const _data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

        if(payOut) {
            const data = _data as ClaimIXDataNotPayOut;
            data.accounts.claimerUserData = await getInitializedUserData(data.escrowState.claimer, data.escrowState.mint, initializeDefaultAmount);
        } else {
            const data = _data as ClaimIXDataPayOut;
            data.accounts.claimerAta = await data.escrowState.mint.mintTo(data.escrowState.claimer.publicKey, initializeDefaultAmount);
            data.accounts.vault = await getInitializedVault(data.escrowState.mint, initializeDefaultAmount);
            data.accounts.vaultAuthority = SwapVaultAuthority;
            data.accounts.tokenProgram = TOKEN_PROGRAM_ID;
        }

        const {result, signature, signerPreBalance, error} = await (payOut ? claimExecuteNotPayOut(_data as ClaimIXDataNotPayOut) : claimExecutePayOut(_data as ClaimIXDataPayOut));

        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong initializer (random)", async () => {
        const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

        data.accounts.initializer = Keypair.generate();

        const {result, signature, signerPreBalance, error} = await claimExecute(data);

        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong initializer (switched)", async () => {
        const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

        data.accounts.initializer = payIn ? data.escrowState.claimer : data.escrowState.offerer;

        const {result, signature, signerPreBalance, error} = await claimExecute(data);

        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong ix sysvar", async () => {
        const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

        data.accounts.ixSysvar = Keypair.generate().publicKey;

        const {result, signature, signerPreBalance, error} = await claimExecute(data);

        assert(error==="ConstraintAddress", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    if(claimWithAccount) {

        parallelTest.it(prefix+"Invalid data account (belongs to different key)", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);
    
            const otherSigner = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
    
            data.dataAccount.signer = otherSigner;

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidUserData", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });
        
    }

    if(kind==="htlc") {

        parallelTest.it(prefix+"Wrong secret", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);

            if(claimWithAccount) {
                data.dataAccount.data = randomBytes(32);
            } else {
                data.params.secret = [...randomBytes(32)];
            }

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidSecret", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"HTLC secret too short", async () => {
            const secret = randomBytes(24);
            const hash = createHash("sha256").update(secret).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, undefined, secret, hash);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            //This results in array index out of bounds - so program error
            assert(error==="ProgramError", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(kind==="chain" || kind==="chainNonced") {
        
        parallelTest.it(prefix+"Wrong transaction", async () => {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            const swapNonce = kind==="chain" ? new BN(0) : new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xF0000000).or(secondPart);

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = locktime.toNumber() + 500000000;
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce);

            data.btcRelayVerify.reversedTxId = [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()];

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            
            if(claimWithAccount) {
                data.dataAccount.data = secret;
            } else {
                data.params.secret = [...secret];
            }

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidSecret", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong transaction output specified", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount);
            
            if(claimWithAccount) {
                const initialData = data.dataAccount.data;
                const initialVout = new BN(initialData.slice(0, 4), undefined, "le");
                data.dataAccount.data = Buffer.concat([initialVout.add(new BN(1)).toBuffer("le", 4), initialData.slice(4)]);
            } else {
                const initialData = Buffer.from(data.params.secret);
                const initialVout = new BN(initialData.slice(0, 4), undefined, "le");
                data.params.secret = [...Buffer.concat([initialVout.add(new BN(1)).toBuffer("le", 4), initialData.slice(4)])];
            }
            
            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidSecret", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"64 byte transaction", async () => {
            let firstPart = new BN(0);
            let secondPart = new BN(0);
            let swapNonce = new BN(0);
            if(kind==="chainNonced") {

                firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
                secondPart = new BN(randomBytes(3));
    
                const nonceBuffer = Buffer.concat([
                    Buffer.from(firstPart.toArray("be", 5)),
                    Buffer.from(secondPart.toArray("be", 3))
                ]);
        
                swapNonce = new BN(nonceBuffer, "be");
            }
            
            const receiveScript = randomBytes(4);
            const receiveAmount = new BN(123002);
            const btcTx = new bitcoin.Transaction();
            
            const locktime = firstPart;
            btcTx.locktime = locktime.toNumber() + 500000000;
            const nSequence = new BN(0xF0000000).or(secondPart);

            //Transaction base length: 4 + 1 + 1 + 4 = 10
            //Input base length: 32 + 4 + 1 + 4 = 41
            //Output base length: 8 + 1 = 9
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), Buffer.alloc(0));
            btcTx.addOutput(receiveScript, receiveAmount.toNumber());
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();

            assert(btcTxSerialized.length===64, "Length of the generated transaction not 64 bytes! Length: "+btcTxSerialized.length);

            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveScript
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);
            
            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidTx", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(kind==="chainNonced") {
        
        parallelTest.it(prefix+"Wrong nonce (timelock)", async () => {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            const swapNonce = new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xF0000000).or(secondPart);

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = new BN(randomBytes(4)).toNumber();
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();
            
            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidNonce", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong nonce (nSequence)", async () => {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            const swapNonce = new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xF0000000).or(new BN(randomBytes(3)));

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = locktime.toNumber() + 500000000;
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();
            
            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidNonce", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Input nSequence has consensus meaning (nSequence < 0xF0000000)", async () => {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            const swapNonce = new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xA1000000).or(secondPart);

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = locktime.toNumber() + 500000000;
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();
            
            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidTx", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Inconsistent nSequence between inputs", async () => {
            const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);
            const secondPart = new BN(randomBytes(3));

            const nonceBuffer = Buffer.concat([
                Buffer.from(firstPart.toArray("be", 5)),
                Buffer.from(secondPart.toArray("be", 3))
            ]);
    
            const swapNonce = new BN(nonceBuffer, "be");

            const locktime = firstPart;
            const nSequence = new BN(0xF0000000).or(secondPart);

            //Generate receive address
            const receiveAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const receiveAmount = new BN(123002);
            const changeAddress = bitcoin.payments.p2wpkh({ hash: randomBytes(20) });
            const btcTx = new bitcoin.Transaction();
            btcTx.addInput(randomBytes(32), 0, nSequence.toNumber(), randomBytes(64));
            btcTx.addInput(randomBytes(32), 1, nSequence.add(new BN(1)).toNumber(), randomBytes(64));
            btcTx.addOutput(receiveAddress.output, receiveAmount.toNumber());
            btcTx.addOutput(changeAddress.output, 2938212);
            btcTx.locktime = locktime.toNumber() + 500000000;
            
            const vout = new BN(0);
            const btcTxSerialized = btcTx.toBuffer();
            
            const btcRelayVerify = {
                reversedTxId: [...createHash("sha256").update(createHash("sha256").update(btcTxSerialized).digest()).digest()],
                confirmations: 6,
                reversedMerkleProof: [[...randomBytes(32)], [...randomBytes(32)], [...randomBytes(32)]],
                txIndex: 5,
                committedHeader: createRandomCommittedHeader()
            }

            const secret = Buffer.concat([vout.toBuffer("le", 4), btcTxSerialized]);
            const hash = createHash("sha256").update(Buffer.concat([
                swapNonce.toBuffer("le", 8),
                receiveAmount.toBuffer("le", 8),
                receiveAddress.output
            ])).digest();

            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount, swapNonce, secret, hash, btcRelayVerify);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidTx", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(kind==="chain" || kind==="chainNonced" || kind==="chainTxhash") {
        
        parallelTest.it(prefix+"Missing btcrelay verify instruction", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            data.btcRelayVerify = null;

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidTxVerifyProgramId", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong btcrelay verify confirmations", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            data.btcRelayVerify.confirmations -= 3;

            const {result, signature, signerPreBalance, error} = await claimExecute(data);

            assert(error==="InvalidTxVerifyConfirmations", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong btcrelay tx hash verified", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            data.btcRelayVerify.reversedTxId = [...randomBytes(32)];

            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="InvalidTxVerifyTxid", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

    if(payOut) {

        parallelTest.it(prefix+"Uninitialized claimer ata", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            await data.escrowState.mint.closeAta(data.escrowState.claimer);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Claimer ata of other mint", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            const otherMint = await getNewMint();
            data.accounts.claimerAta = await otherMint.mintTo(data.escrowState.claimer.publicKey, initializeDefaultAmount);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Bad mint vault", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            const otherMint = await getNewMint();
            data.accounts.vault = await getInitializedVault(otherMint, initializeDefaultAmount);

            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Wrong vault authority", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataPayOut;
    
            data.accounts.vaultAuthority = RandomPDA();

            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    } else {
        
        parallelTest.it(prefix+"ClaimerUserData of other signer", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataNotPayOut;
    
            const otherClaimer = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));

            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, data.escrowState.mint, initializeDefaultAmount);
    
            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"ClaimerUserData of other mint", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataNotPayOut;
    
            const otherMint = await getNewMint();

            data.accounts.claimerUserData = await getInitializedUserData(data.escrowState.claimer, otherMint, initializeDefaultAmount);
    
            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"ClaimerUserData of other signer & mint", async () => {
            const data = await getClaimDefaultData(payIn, payOut, kind, claimWithAccount) as ClaimIXDataNotPayOut;
    
            const otherMint = await getNewMint();

            const otherClaimer = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherClaimer.publicKey, 1000000000));

            data.accounts.claimerUserData = await getInitializedUserData(otherClaimer, otherMint, initializeDefaultAmount);
    
            const {result, signature, signerPreBalance, error} = await claimExecute(data);
    
            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

    }

}

describe("swap-program: Claim", () => {

    const payInVariants = [false, true];
    const payOutVariants = [false, true];
    const kindVariants: SwapType[] = ["htlc", "chain", "chainNonced", "chainTxhash"];
    const claimVariants = [false, true];

    for(let payIn of payInVariants) {
        for(let payOut of payOutVariants) {
            for(let kind of kindVariants) {
                for(let claim of claimVariants) {
                    runTestsWith(payIn, payOut, kind, claim);
                }
            }
        }
    }

    parallelTest.execute();

});