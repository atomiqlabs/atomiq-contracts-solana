import { Keypair, SystemProgram, PublicKey, SignatureResult } from "@solana/web3.js";
import { AnchorProvider, Program, workspace } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import { BN } from "bn.js";
import { TokenMint, getNewMint } from "../utils/tokens";
import { RandomPDA, SwapUserVault, SwapVault } from "../utils/accounts";
import { Account, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { getInitializedUserData } from "../utils/userData";
import { getInitializedVault } from "../utils/vault";
import { getTxWithRetries, ParalelizedTest } from "../utils";
import { CombinedProgramErrorType, parseSwapProgramError } from "../utils/program";

const NATIVE_VAULT_LAMPORTS_RENT = 946_560;
const USER_ACCOUNT_RENT = 2_345_520;

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();

const depositAmount = new BN(100);
const notEnoughAmount = new BN(50);

assert(notEnoughAmount.lt(depositAmount));

type IXAccounts = {
    signer: Keypair,
    mintData: TokenMint,
    signerAta: PublicKey,
    userData: PublicKey,
    vault: PublicKey,
    mint: PublicKey,
    systemProgram: PublicKey,
    tokenProgram: PublicKey
};

type IXAccountsSol = {
    signer: Keypair,
    userData: PublicKey,
    vault: PublicKey,
    systemProgram: PublicKey
};

async function getDefaultAccounts(noSignerAta?: boolean): Promise<IXAccounts> {
    const signer = Keypair.generate();
    const mintData = await getNewMint();
    const signerAta = noSignerAta ? null : await mintData.mintTo(signer.publicKey, depositAmount);
    const userData = SwapUserVault(signer.publicKey, mintData.mint);
    const vault = SwapVault(mintData.mint);
    const mint = mintData.mint;
    const systemProgram = SystemProgram.programId;
    const tokenProgram = TOKEN_PROGRAM_ID;

    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(signer.publicKey, 1000000000));

    return {
        signer,
        mintData,
        signerAta,
        userData,
        vault,
        mint,
        systemProgram,
        tokenProgram
    };
}

async function getDefaultAccountsSol(): Promise<IXAccountsSol> {
    const signer = Keypair.generate();
    const userData = SwapUserVault(signer.publicKey, PublicKey.default);
    const vault = SwapVault(PublicKey.default);
    const systemProgram = SystemProgram.programId;

    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(signer.publicKey, new BN(1000000000).add(depositAmount).toNumber()));

    return {
        signer,
        userData,
        vault,
        systemProgram
    };
}

async function execute(accounts: IXAccounts): Promise<{result: SignatureResult, error: CombinedProgramErrorType}> {
    
    const tx = await program.methods.deposit(depositAmount).accounts({
        signer: accounts.signer.publicKey,
        signerAta: accounts.signerAta,
        userData: accounts.userData,
        vault: accounts.vault,
        mint: accounts.mint,
        systemProgram: accounts.systemProgram,
        tokenProgram: accounts.tokenProgram
    }).transaction();

    tx.feePayer = accounts.signer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [accounts.signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature);

    return {
        result: result.value,
        error: parseSwapProgramError(0, result.value.err)
    };

}

async function executeSol(accounts: IXAccountsSol, amountOverride?: number): Promise<{result: SignatureResult, error: CombinedProgramErrorType, signature: string}> {
    
    const tx = await program.methods.depositSol(amountOverride==null ? depositAmount : new BN(amountOverride)).accounts({
        signer: accounts.signer.publicKey,
        userData: accounts.userData,
        vault: accounts.vault,
        systemProgram: accounts.systemProgram
    }).transaction();

    tx.feePayer = accounts.signer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [accounts.signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature);

    return {
        result: result.value,
        signature,
        error: parseSwapProgramError(0, result.value.err)
    };

}

const parallelTest = new ParalelizedTest();

describe("swap-program: Deposit", () => {
    parallelTest.it("Deposit uninitialized vault & uninitialized user data", async () => {
        const accs = await getDefaultAccounts();
        
        const initialSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const initialVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error} = await execute(accs);

        const postSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const postVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));
        assert(initialSignerAtaBalance.sub(depositAmount).eq(postSignerAtaBalance), "Signer ATA balance error");
        assert(initialVaultBalance.add(depositAmount).eq(postVaultBalance), "Vault ATA balance error");
        assert(initialUserDataBalance.add(depositAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("Deposit initialized vault & uninitialized user data", async () => {
        const accs = await getDefaultAccounts();
        
        await getInitializedVault(accs.mintData, depositAmount);

        const initialSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const initialVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error} = await execute(accs);

        const postSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const postVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));
        assert(initialSignerAtaBalance.sub(depositAmount).eq(postSignerAtaBalance), "Signer ATA balance error");
        assert(initialVaultBalance.add(depositAmount).eq(postVaultBalance), "Vault ATA balance error");
        assert(initialUserDataBalance.add(depositAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("Deposit initialized vault & initialized user data", async () => {
        const accs = await getDefaultAccounts();
        
        await getInitializedVault(accs.mintData, depositAmount);
        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        const initialSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const initialVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error} = await execute(accs);

        const postSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).then(e => new BN(e.amount.toString()));
        const postVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));
        assert(initialSignerAtaBalance.sub(depositAmount).eq(postSignerAtaBalance), "Signer ATA balance error");
        assert(initialVaultBalance.add(depositAmount).eq(postVaultBalance), "Vault ATA balance error");
        assert(initialUserDataBalance.add(depositAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("Uninitialized ATA", async () => {
        const accs = await getDefaultAccounts(true);
        
        accs.signerAta = await accs.mintData.getATA(accs.signer.publicKey);

        const {result, error} = await execute(accs);

        assert(error==="AccountNotInitialized", "Transaction should've failed!");
    });

    parallelTest.it("ATA for other mint", async () => {
        const accs = await getDefaultAccounts(true);

        const otherMintData = await getNewMint();
        accs.signerAta = await otherMintData.mintTo(accs.signer.publicKey, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintTokenMint", "Transaction should've failed!");
    });

    parallelTest.it("ATA with not enough funds", async () => {
        const accs = await getDefaultAccounts(true);
        
        accs.signerAta = await accs.mintData.mintTo(accs.signer.publicKey, notEnoughAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintRaw", "Transaction should've failed!");
    });

    parallelTest.it("User account of other user", async () => {
        const accs = await getDefaultAccounts();

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        accs.userData = await getInitializedUserData(otherSigner, accs.mintData, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("User account of other mint", async () => {
        const accs = await getDefaultAccounts();

        const otherMintData = await getNewMint();
        accs.userData = await getInitializedUserData(accs.signer, otherMintData, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("User account of other signer & mint", async () => {
        const accs = await getDefaultAccounts();

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        const otherMintData = await getNewMint();
        accs.userData = await getInitializedUserData(otherSigner, otherMintData, depositAmount);
        
        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("Wrong mint vault (different mint)", async () => {
        const accs = await getDefaultAccounts();

        const otherMintData = await getNewMint();
        accs.vault = await getInitializedVault(otherMintData, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("Wrong mint", async () => {
        const accs = await getDefaultAccounts();

        const otherMintData = await getNewMint();
        accs.mint = otherMintData.mint;

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    //Native SOL
    parallelTest.it("[SOL] Uninitialized user data", async () => {
        const accs = await getDefaultAccountsSol();
        
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error, signature} = await executeSol(accs);

        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

        const transactionResult = await getTxWithRetries(provider, signature);

        const signerAccountIndex = transactionResult.transaction.message.accountKeys.findIndex(val => val.equals(accs.signer.publicKey));
        const vaultAccountIndex = transactionResult.transaction.message.accountKeys.findIndex(val => val.equals(accs.vault));

        let additionalVaultRent = 0;
        let totalFeeAndRent = transactionResult.transaction.signatures.length * 5000 + USER_ACCOUNT_RENT;
        if(transactionResult.meta.preBalances[vaultAccountIndex]===0) {
            //Needed to initialize
            totalFeeAndRent += (additionalVaultRent = NATIVE_VAULT_LAMPORTS_RENT);
        }

        assert(transactionResult.meta.preBalances[signerAccountIndex] - depositAmount.toNumber() - totalFeeAndRent === transactionResult.meta.postBalances[signerAccountIndex], "Signer balance error");
        assert(transactionResult.meta.preBalances[vaultAccountIndex] + depositAmount.toNumber() + additionalVaultRent === transactionResult.meta.postBalances[vaultAccountIndex], "Vault balance error");
        assert(initialUserDataBalance.add(depositAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("[SOL] Initialized user data", async () => {
        const accs = await getDefaultAccountsSol();

        await getInitializedVault(null, depositAmount);
        await getInitializedUserData(accs.signer, null, depositAmount);
        
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error, signature} = await executeSol(accs);

        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));

        const transactionResult = await getTxWithRetries(provider, signature);

        const signerAccountIndex = transactionResult.transaction.message.accountKeys.findIndex(val => val.equals(accs.signer.publicKey));
        const vaultAccountIndex = transactionResult.transaction.message.accountKeys.findIndex(val => val.equals(accs.vault));

        let totalFee = transactionResult.transaction.signatures.length * 5000;

        assert(transactionResult.meta.preBalances[signerAccountIndex] - depositAmount.toNumber() - totalFee === transactionResult.meta.postBalances[signerAccountIndex], "Signer balance error");
        assert(transactionResult.meta.preBalances[vaultAccountIndex] + depositAmount.toNumber() === transactionResult.meta.postBalances[vaultAccountIndex], "Vault balance error");
        assert(initialUserDataBalance.add(depositAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("[SOL] Not enough funds", async () => {
        const accs = await getDefaultAccountsSol();

        const {result} = await executeSol(accs, 1_000_000_000_000_000);

        const error = (result.err as any).InstructionError;

        assert(error[0]===0, "Transaction should've failed on ix 0!");
        assert(error[1].Custom===1, "Transaction should've failed with custom error 1!");
    });

    parallelTest.it("[SOL] User account of other user", async () => {
        const accs = await getDefaultAccountsSol();

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        accs.userData = await getInitializedUserData(otherSigner, null, depositAmount);

        const {result, error} = await executeSol(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("[SOL] User account of other mint", async () => {
        const accs = await getDefaultAccountsSol();

        const otherMintData = await getNewMint();
        accs.userData = await getInitializedUserData(accs.signer, otherMintData, depositAmount);

        const {result, error} = await executeSol(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("[SOL] User account of other signer & mint", async () => {
        const accs = await getDefaultAccountsSol();

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        const otherMintData = await getNewMint();
        accs.userData = await getInitializedUserData(otherSigner, otherMintData, depositAmount);
        
        const {result, error} = await executeSol(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.it("[SOL] Wrong mint vault (different mint)", async () => {
        const accs = await getDefaultAccountsSol();

        const otherMintData = await getNewMint();
        accs.vault = await getInitializedVault(otherMintData, depositAmount);

        const {result, error} = await executeSol(accs);

        assert(error==="ConstraintSeeds", "Transaction should've failed!");
    });

    parallelTest.execute();

});