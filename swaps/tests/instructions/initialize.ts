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
import { InitializeIXData, InitializeIXDataNotPayIn, InitializeIXDataPayIn, SwapData, SwapType, SwapTypeEnum, getInitializeDefaultDataNotPayIn, getInitializeDefaultDataPayIn, initializeDefaultAmount, initializeExecuteNotPayIn, initializeExecutePayIn } from "../utils/escrowState";
import { ParalelizedTest } from "../utils";
import { CombinedProgramErrorType } from "../utils/program";
import { getInitializedVault } from "../utils/vault";

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();
const eventParser = new EventParser(program.programId, program.coder);

const escrowAmount = initializeDefaultAmount;
const tooMuchAmount = new BN(150);

assert(escrowAmount.lt(tooMuchAmount));

const parallelTest = new ParalelizedTest();

function runCommonTest(
    prefix: string,
    execute: (data: InitializeIXData) => Promise<{result:SignatureResult, signature: string, error: CombinedProgramErrorType}>,
    getDefaultInitializeData: (
        payOut: boolean,
        noInitClaimer?: boolean,
        noInitOfferer?: boolean,
        kind?: SwapType, 
        expiry?: number, 
        hash?: Buffer, 
        amount?: BN, 
        confirmations?: number, 
        nonce?: BN,
        sequence?: BN,
        txoHash?: Buffer
    ) => Promise<InitializeIXData>
) {

    parallelTest.it(prefix+"Initialize with wrong payIn", async () => {
        const data = await getDefaultInitializeData(true);
        
        data.params.swapData.payIn = !data.params.swapData.payIn;

        if(data.params.swapData.payIn) {
            (data as InitializeIXDataPayIn).accounts.offererAta = await data.mintData.mintTo(data.accounts.offerer.publicKey, initializeDefaultAmount);
            (data as InitializeIXDataPayIn).accounts.vault = SwapVault(data.mintData.mint);
            (data as InitializeIXDataPayIn).accounts.vaultAuthority = SwapVaultAuthority;
            (data as InitializeIXDataPayIn).accounts.tokenProgram = TOKEN_PROGRAM_ID;
        } else {
            (data as InitializeIXDataNotPayIn).accounts.offererUserData = await getInitializedUserData(data.accounts.offerer, data.mintData, initializeDefaultAmount);
        }

        const {result, signature, error} = await execute(data);

        assert(error==="InvalidSwapDataPayIn", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Expired authorization", async () => {
        const data = await getDefaultInitializeData(true);
        
        data.params.authExpiry = new BN(Math.floor(Date.now()/1000)-3600);

        const {result, signature, error} = await execute(data);

        assert(error==="AuthExpired", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Wrong escrow state", async () => {
        const data = await getDefaultInitializeData(true);

        data.accounts.escrowState = SwapEscrowState(randomBytes(32));

        const {result, signature, error} = await execute(data);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Already initialized escrow state", async () => {
        const data = await getDefaultInitializeData(true);

        const {result, signature} = await execute(data);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

        const data2 = await getDefaultInitializeData(true, undefined, undefined, undefined, undefined, Buffer.from(data.params.swapData.hash));
        
        const {result: result2, signature: signature2, error} = await execute(data2);

        // const txData = await provider.connection.getTransaction(signature2, { commitment: "confirmed" });
        // console.log("Transaction logs: ", txData.meta.logMessages);

        assert(error==="AccountAlreadyInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result2.err));
    });
    
    parallelTest.it(prefix+"Too many confirmations", async () => {
        const data = await getDefaultInitializeData(true, undefined, undefined, undefined, undefined, undefined, undefined, 250);

        const {result, signature, error} = await execute(data);

        assert(error==="TooManyConfirmations", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Kind===HTLC but nonce provided", async () => {
        const data = await getDefaultInitializeData(true, undefined, undefined, "htlc", undefined, undefined, undefined, undefined, new BN(randomBytes(8)));

        const {result, signature, error} = await execute(data);

        assert(error==="InvalidSwapDataNonce", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Kind===Chain but nonce provided", async () => {
        const data = await getDefaultInitializeData(true, undefined, undefined, "chain", undefined, undefined, undefined, undefined, new BN(randomBytes(8)));

        const {result, signature, error} = await execute(data);

        assert(error==="InvalidSwapDataNonce", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"Kind===chainTxhash but nonce provided", async () => {
        const data = await getDefaultInitializeData(true, undefined, undefined, "chainTxhash", undefined, undefined, undefined, undefined, new BN(randomBytes(8)));

        const {result, signature, error} = await execute(data);

        assert(error==="InvalidSwapDataNonce", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=true: Uninitialized claimerAta", async () => {
        const data = await getDefaultInitializeData(true, true);

        const {result, signature, error} = await execute(data);

        assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=true: claimerAta of other mint", async () => {
        const data = await getDefaultInitializeData(true, true);

        const otherMint = await getNewMint();
        data.accounts.claimerAta = await otherMint.mintTo(data.accounts.claimer.publicKey, escrowAmount);

        const {result, signature, error} = await execute(data);

        assert(error==="ConstraintTokenMint", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=false: Uninitialized claimerUserData", async () => {
        const data = await getDefaultInitializeData(false, true);

        const {result, signature, error} = await execute(data);

        assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=false: claimerUserData of other signer", async () => {
        const data = await getDefaultInitializeData(false, true);

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        data.accounts.claimerUserData = await getInitializedUserData(otherSigner, data.mintData, escrowAmount);

        const {result, signature, error} = await execute(data);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=false: claimerUserData of other mint", async () => {
        const data = await getDefaultInitializeData(false, true);

        const otherMint = await getNewMint();
        data.accounts.claimerUserData = await getInitializedUserData(data.accounts.claimer, otherMint, escrowAmount);

        const {result, signature, error} = await execute(data);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it(prefix+"payOut=false: claimerUserData of other signer & mint", async () => {
        const data = await getDefaultInitializeData(false, true);

        const otherMint = await getNewMint();
        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        data.accounts.claimerUserData = await getInitializedUserData(otherSigner, otherMint, escrowAmount);

        const {result, signature, error} = await execute(data);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });
}

describe("swap-program: Initialize", () => {

    {
        const prefix = "Initialize(NOT payIn): ";
        
        parallelTest.it(prefix+"Initialize payOut=true", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true);
            
            const initialUserDataBalance = await program.account.userAccount.fetchNullable(data.accounts.offererUserData).then(e => e==null ? new BN(0) : e.amount);

            const {result, signature} = await initializeExecuteNotPayIn(data);

            assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

            const postUserDataBalance = await program.account.userAccount.fetchNullable(data.accounts.offererUserData).then(e => e==null ? new BN(0) : e.amount);
            const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);

            assert(initialUserDataBalance.sub(escrowAmount).eq(postUserDataBalance), "User data balance error");

            assert(escrowState!=null, "Escrow not created!");
            assert(escrowState.claimer.equals(data.accounts.claimer.publicKey), "Escrow: Invalid claimer!");
            assert(escrowState.claimerAta.equals(data.accounts.claimerAta), "Escrow: Invalid claimerAta!");
            assert(escrowState.claimerBounty.eq(data.params.claimerBounty), "Escrow: Invalid claimerBounty!");
            assert(SwapData.equals(escrowState.data, data.params.swapData), "Escrow: Invalid swapData!");
            assert(escrowState.mint.equals(data.accounts.mint), "Escrow: Invalid mint!");
            assert(escrowState.offerer.equals(data.accounts.offerer.publicKey), "Escrow: Invalid offerer!");
            assert(escrowState.offererAta.equals(PublicKey.default), "Escrow: Invalid offererAta!");
            assert(escrowState.securityDeposit.eq(data.params.securityDeposit), "Escrow: Invalid securityDeposit!");
            
            //Check that event was emitted
            const tx = await provider.connection.getTransaction(signature, {
                commitment: "confirmed"
            });
            
            const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

            let eventFound = false;
            for(let event of parsedEvents) {
                if(event.name==="InitializeEvent") {
                    eventFound = true;

                    const hash: Buffer = Buffer.from(event.data.hash as number[]);
                    const txoHash: Buffer = Buffer.from(event.data.txoHash as number[]);
                    const nonce: BN = event.data.nonce as BN;
                    const kind: SwapTypeEnum = event.data.kind as SwapTypeEnum;
                    const sequence: BN = event.data.sequence as BN;
                    
                    assert(hash.equals(Buffer.from(data.params.swapData.hash)), "Event: invalid hash!");
                    assert(txoHash.equals(Buffer.from(data.params.txoHash)), "Event: invalid txoHash!");
                    assert(nonce.eq(data.params.swapData.nonce), "Event: invalid nonce!");
                    assert(Object.keys(kind)[0]===Object.keys(data.params.swapData.kind)[0], "Event: invalid kind");
                    assert(sequence.eq(data.params.swapData.sequence), "Event: invalid sequence!");
                    
                }
            }

            assert(eventFound, "Event: not emitted!");

        });

        parallelTest.it(prefix+"Initialize payOut=false", async () => {
            const data = await getInitializeDefaultDataNotPayIn(false);
            
            const initialUserDataBalance = await program.account.userAccount.fetchNullable(data.accounts.offererUserData).then(e => e==null ? new BN(0) : e.amount);

            const {result, signature} = await initializeExecuteNotPayIn(data);

            assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

            const postUserDataBalance = await program.account.userAccount.fetchNullable(data.accounts.offererUserData).then(e => e==null ? new BN(0) : e.amount);
            const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);

            assert(initialUserDataBalance.sub(escrowAmount).eq(postUserDataBalance), "User data balance error");

            assert(escrowState!=null, "Escrow not created!");
            assert(escrowState.claimer.equals(data.accounts.claimer.publicKey), "Escrow: Invalid claimer!");
            assert(escrowState.claimerAta.equals(PublicKey.default), "Escrow: Invalid claimerAta!");
            assert(escrowState.claimerBounty.eq(data.params.claimerBounty), "Escrow: Invalid claimerBounty!");
            assert(SwapData.equals(escrowState.data, data.params.swapData), "Escrow: Invalid swapData!");
            assert(escrowState.mint.equals(data.accounts.mint), "Escrow: Invalid mint!");
            assert(escrowState.offerer.equals(data.accounts.offerer.publicKey), "Escrow: Invalid offerer!");
            assert(escrowState.offererAta.equals(PublicKey.default), "Escrow: Invalid offererAta!");
            assert(escrowState.securityDeposit.eq(data.params.securityDeposit), "Escrow: Invalid securityDeposit!");
            
            //Check that event was emitted
            const tx = await provider.connection.getTransaction(signature, {
                commitment: "confirmed"
            });
            
            const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

            let eventFound = false;
            for(let event of parsedEvents) {
                if(event.name==="InitializeEvent") {
                    eventFound = true;

                    const hash: Buffer = Buffer.from(event.data.hash as number[]);
                    const txoHash: Buffer = Buffer.from(event.data.txoHash as number[]);
                    const nonce: BN = event.data.nonce as BN;
                    const kind: SwapTypeEnum = event.data.kind as SwapTypeEnum;
                    const sequence: BN = event.data.sequence as BN;
                    
                    assert(hash.equals(Buffer.from(data.params.swapData.hash)), "Event: invalid hash!");
                    assert(txoHash.equals(Buffer.from(data.params.txoHash)), "Event: invalid txoHash!");
                    assert(nonce.eq(data.params.swapData.nonce), "Event: invalid nonce!");
                    assert(Object.keys(kind)[0]===Object.keys(data.params.swapData.kind)[0], "Event: invalid kind");
                    assert(sequence.eq(data.params.swapData.sequence), "Event: invalid sequence!");
                    
                }
            }

            assert(eventFound, "Event: not emitted!");

        });

        runCommonTest(prefix, initializeExecuteNotPayIn, getInitializeDefaultDataNotPayIn);

        parallelTest.it(prefix+"Uninitialized offererUserData", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true, null, true);

            const {result, signature, error} = await initializeExecuteNotPayIn(data);

            assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererUserData with not enough funds", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true);

            data.params.swapData.amount = tooMuchAmount;

            const {result, signature, error} = await initializeExecuteNotPayIn(data);

            assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererUserData of other signer", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true, null, true);

            const otherSigner = Keypair.generate();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
            const otherUserData = await getInitializedUserData(otherSigner, data.mintData, escrowAmount);

            data.accounts.offererUserData = otherUserData;

            const {result, signature, error} = await initializeExecuteNotPayIn(data);

            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererUserData of other mint", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true, null, true);

            const otherMintData = await getNewMint();
            const otherUserData = await getInitializedUserData(data.accounts.offerer, otherMintData, escrowAmount);

            data.accounts.offererUserData = otherUserData;

            const {result, signature, error} = await initializeExecuteNotPayIn(data);

            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererUserData of other signer & mint", async () => {
            const data = await getInitializeDefaultDataNotPayIn(true, null, true);

            const otherSigner = Keypair.generate();
            const otherMintData = await getNewMint();
            await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
            const otherUserData = await getInitializedUserData(otherSigner, otherMintData, escrowAmount);

            data.accounts.offererUserData = otherUserData;

            const {result, signature, error} = await initializeExecuteNotPayIn(data);

            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });
    }

    {
        const prefix = "Initialize(payIn): ";
        
        parallelTest.it(prefix+"Initialize payOut=true", async () => {
            const data = await getInitializeDefaultDataPayIn(true);
            
            const initialOffererAtaBalance = await getAccount(provider.connection, data.accounts.offererAta).then(e => new BN(e.amount.toString()));
            const initialVaultBalance = await getAccount(provider.connection, data.accounts.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));

            const {result, signature} = await initializeExecutePayIn(data);

            assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

            const postOffererAtaBalance = await getAccount(provider.connection, data.accounts.offererAta).then(e => new BN(e.amount.toString()));
            const postVaultBalance = await getAccount(provider.connection, data.accounts.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
            const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);

            assert(initialOffererAtaBalance.sub(escrowAmount).eq(postOffererAtaBalance), "Offerer ata balance error");
            assert(initialVaultBalance.add(escrowAmount).eq(postVaultBalance), "Vault balance error");

            assert(escrowState!=null, "Escrow not created!");
            assert(escrowState.claimer.equals(data.accounts.claimer.publicKey), "Escrow: Invalid claimer!");
            assert(escrowState.claimerAta.equals(data.accounts.claimerAta), "Escrow: Invalid claimerAta!");
            assert(escrowState.claimerBounty.eq(new BN(0)), "Escrow: Invalid claimerBounty!");
            assert(SwapData.equals(escrowState.data, data.params.swapData), "Escrow: Invalid swapData!");
            assert(escrowState.mint.equals(data.accounts.mint), "Escrow: Invalid mint!");
            assert(escrowState.offerer.equals(data.accounts.offerer.publicKey), "Escrow: Invalid offerer!");
            assert(escrowState.offererAta.equals(data.accounts.offererAta), "Escrow: Invalid offererAta!");
            assert(escrowState.securityDeposit.eq(new BN(0)), "Escrow: Invalid securityDeposit!");
            
            //Check that event was emitted
            const tx = await provider.connection.getTransaction(signature, {
                commitment: "confirmed"
            });
            
            const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

            let eventFound = false;
            for(let event of parsedEvents) {
                if(event.name==="InitializeEvent") {
                    eventFound = true;

                    const hash: Buffer = Buffer.from(event.data.hash as number[]);
                    const txoHash: Buffer = Buffer.from(event.data.txoHash as number[]);
                    const nonce: BN = event.data.nonce as BN;
                    const kind: SwapTypeEnum = event.data.kind as SwapTypeEnum;
                    const sequence: BN = event.data.sequence as BN;
                    
                    assert(hash.equals(Buffer.from(data.params.swapData.hash)), "Event: invalid hash!");
                    assert(txoHash.equals(Buffer.from(data.params.txoHash)), "Event: invalid txoHash!");
                    assert(nonce.eq(data.params.swapData.nonce), "Event: invalid nonce!");
                    assert(Object.keys(kind)[0]===Object.keys(data.params.swapData.kind)[0], "Event: invalid kind");
                    assert(sequence.eq(data.params.swapData.sequence), "Event: invalid sequence!");
                    
                }
            }

            assert(eventFound, "Event: not emitted!");

        });

        parallelTest.it(prefix+"Initialize payOut=false", async () => {
            const data = await getInitializeDefaultDataPayIn(false);
            
            const initialOffererAtaBalance = await getAccount(provider.connection, data.accounts.offererAta).then(e => new BN(e.amount.toString()));
            const initialVaultBalance = await getAccount(provider.connection, data.accounts.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));

            const {result, signature} = await initializeExecutePayIn(data);

            assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

            const postOffererAtaBalance = await getAccount(provider.connection, data.accounts.offererAta).then(e => new BN(e.amount.toString()));
            const postVaultBalance = await getAccount(provider.connection, data.accounts.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
            const escrowState = await program.account.escrowState.fetchNullable(data.accounts.escrowState);

            assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

            assert(initialOffererAtaBalance.sub(escrowAmount).eq(postOffererAtaBalance), "Offerer ata balance error");
            assert(initialVaultBalance.add(escrowAmount).eq(postVaultBalance), "Vault balance error");

            assert(escrowState!=null, "Escrow not created!");
            assert(escrowState.claimer.equals(data.accounts.claimer.publicKey), "Escrow: Invalid claimer!");
            assert(escrowState.claimerAta.equals(PublicKey.default), "Escrow: Invalid claimerAta!");
            assert(escrowState.claimerBounty.eq(new BN(0)), "Escrow: Invalid claimerBounty!");
            assert(SwapData.equals(escrowState.data, data.params.swapData), "Escrow: Invalid swapData!");
            assert(escrowState.mint.equals(data.accounts.mint), "Escrow: Invalid mint!");
            assert(escrowState.offerer.equals(data.accounts.offerer.publicKey), "Escrow: Invalid offerer!");
            assert(escrowState.offererAta.equals(data.accounts.offererAta), "Escrow: Invalid offererAta!");
            assert(escrowState.securityDeposit.eq(new BN(0)), "Escrow: Invalid securityDeposit!");
            
            //Check that event was emitted
            const tx = await provider.connection.getTransaction(signature, {
                commitment: "confirmed"
            });
            
            const parsedEvents = eventParser.parseLogs(tx.meta.logMessages);

            let eventFound = false;
            for(let event of parsedEvents) {
                if(event.name==="InitializeEvent") {
                    eventFound = true;

                    const hash: Buffer = Buffer.from(event.data.hash as number[]);
                    const txoHash: Buffer = Buffer.from(event.data.txoHash as number[]);
                    const nonce: BN = event.data.nonce as BN;
                    const kind: SwapTypeEnum = event.data.kind as SwapTypeEnum;
                    const sequence: BN = event.data.sequence as BN;
                    
                    assert(hash.equals(Buffer.from(data.params.swapData.hash)), "Event: invalid hash!");
                    assert(txoHash.equals(Buffer.from(data.params.txoHash)), "Event: invalid txoHash!");
                    assert(nonce.eq(data.params.swapData.nonce), "Event: invalid nonce!");
                    assert(Object.keys(kind)[0]===Object.keys(data.params.swapData.kind)[0], "Event: invalid kind");
                    assert(sequence.eq(data.params.swapData.sequence), "Event: invalid sequence!");
                    
                }
            }

            assert(eventFound, "Event: not emitted!");

        });

        runCommonTest(prefix, initializeExecutePayIn, getInitializeDefaultDataPayIn);

        parallelTest.it(prefix+"Uninitialized offererAta", async () => {
            const data = await getInitializeDefaultDataPayIn(true, null, true);

            const {result, signature, error} = await initializeExecutePayIn(data);

            assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererAta of other mint", async () => {
            const data = await getInitializeDefaultDataPayIn(true, null, true);

            const otherMint = await getNewMint();
            data.accounts.offererAta = await otherMint.mintTo(data.accounts.offerer.publicKey, escrowAmount);

            const {result, signature, error} = await initializeExecutePayIn(data);

            assert(error==="ConstraintTokenMint", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"offererAta with not enough funds", async () => {
            const data = await getInitializeDefaultDataPayIn(true);

            data.params.swapData.amount = tooMuchAmount;

            const {result, signature, error} = await initializeExecutePayIn(data);

            assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });

        parallelTest.it(prefix+"Bad mint vault", async () => {
            const data = await getInitializeDefaultDataPayIn(true);

            const otherMint = await getNewMint();
            data.accounts.vault = await getInitializedVault(otherMint, initializeDefaultAmount);

            const {result, signature, error} = await initializeExecutePayIn(data);

            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });
        
        parallelTest.it(prefix+"Wrong vault authority", async () => {
            const data = await getInitializeDefaultDataPayIn(true);

            data.accounts.vaultAuthority = RandomPDA();

            const {result, signature, error} = await initializeExecutePayIn(data);

            assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
        });
    }

    parallelTest.execute();

});
