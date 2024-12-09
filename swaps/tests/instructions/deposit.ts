import { Keypair, SystemProgram, PublicKey, SignatureResult } from "@solana/web3.js";
import { AnchorProvider, Program, workspace } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import { BN } from "bn.js";
import { TokenMint, getNewMint } from "../utils/tokens";
import { RandomPDA, SwapUserVault, SwapVault, SwapVaultAuthority } from "../utils/accounts";
import { Account, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { getInitializedUserData } from "../utils/userData";
import { getInitializedVault } from "../utils/vault";
import { ParalelizedTest } from "../utils";
import { CombinedProgramErrorType, parseSwapProgramError } from "../utils/program";

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
    vaultAuthority: PublicKey,
    mint: PublicKey,
    systemProgram: PublicKey,
    tokenProgram: PublicKey
};

async function getDefaultAccounts(noSignerAta?: boolean): Promise<IXAccounts> {
    const signer = Keypair.generate();
    const mintData = await getNewMint();
    const signerAta = noSignerAta ? null : await mintData.mintTo(signer.publicKey, depositAmount);
    const userData = SwapUserVault(signer.publicKey, mintData.mint);
    const vault = SwapVault(mintData.mint);
    const vaultAuthority = SwapVaultAuthority;
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
        vaultAuthority,
        mint,
        systemProgram,
        tokenProgram
    };
}

async function execute(accounts: IXAccounts): Promise<{result: SignatureResult, error: CombinedProgramErrorType}> {
    
    const tx = await program.methods.deposit(depositAmount).accounts({
        signer: accounts.signer.publicKey,
        signerAta: accounts.signerAta,
        userData: accounts.userData,
        vault: accounts.vault,
        vaultAuthority: accounts.vaultAuthority,
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

    parallelTest.it("Wrong mint vault authority - random", async () => {
        const accs = await getDefaultAccounts();

        accs.vaultAuthority = RandomPDA();

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

    parallelTest.execute();

});