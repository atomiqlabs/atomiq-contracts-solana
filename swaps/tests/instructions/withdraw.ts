import { Keypair, SystemProgram, PublicKey, SignatureResult } from "@solana/web3.js";
import { AnchorProvider, Program, workspace, BN } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
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
const withdrawAmount = new BN(100);
const withdrawTooMuch = new BN(150);

assert(withdrawAmount.lte(depositAmount));
assert(withdrawTooMuch.gt(depositAmount));

type IXAccounts = {
    signer: Keypair,
    mintData: TokenMint,
    signerAta: PublicKey,
    userData: PublicKey,
    vault: PublicKey,
    vaultAuthority: PublicKey,
    mint: PublicKey,
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
        tokenProgram
    };
}

async function execute(accounts: IXAccounts, _withdrawAmount?: BN): Promise<{result: SignatureResult, error: CombinedProgramErrorType, signature: string}> {
    
    const tx = await program.methods.withdraw(_withdrawAmount || withdrawAmount).accounts({
        signer: accounts.signer.publicKey,
        signerAta: accounts.signerAta,
        userData: accounts.userData,
        vault: accounts.vault,
        vaultAuthority: accounts.vaultAuthority,
        mint: accounts.mint,
        tokenProgram: accounts.tokenProgram
    }).transaction();

    tx.feePayer = accounts.signer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [accounts.signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: result.value,
        error: parseSwapProgramError(0, result.value.err),
        signature
    };

}

const parallelTest = new ParalelizedTest();

describe("swap-program: Withdraw", () => {
    parallelTest.it("Withdraw success", async () => {
        const accs = await getDefaultAccounts();
        
        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        const initialSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const initialVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const initialUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        const {result, error} = await execute(accs);

        const postSignerAtaBalance = await getAccount(provider.connection, accs.signerAta).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postVaultBalance = await getAccount(provider.connection, accs.vault).catch(e => {}).then(e => e==null ? new BN(0) : new BN((e as Account).amount.toString()));
        const postUserDataBalance = await program.account.userAccount.fetchNullable(accs.userData).then(e => e==null ? new BN(0) : e.amount);

        assert(result.err==null, "Transaction error: "+JSON.stringify(result.err, null, 4));
        assert(initialSignerAtaBalance.add(withdrawAmount).eq(postSignerAtaBalance), "Signer ATA balance error");
        assert(initialVaultBalance.sub(withdrawAmount).eq(postVaultBalance), "Vault ATA balance error");
        assert(initialUserDataBalance.sub(withdrawAmount).eq(postUserDataBalance), "User data balance error");
    });

    parallelTest.it("Uninitialized signer_ata", async () => {
        const accs = await getDefaultAccounts(true);
        accs.signerAta = await accs.mintData.getATA(accs.signer.publicKey);
        
        await getInitializedUserData(accs.signer, accs.mintData, depositAmount, true);

        const {result, error} = await execute(accs);

        assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("signer_ata for other mint", async () => {
        const accs = await getDefaultAccounts(true);

        const otherMint = await getNewMint();
        accs.signerAta = await otherMint.mintTo(accs.signer.publicKey, depositAmount);
        
        await getInitializedUserData(accs.signer, accs.mintData, depositAmount, true);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintTokenMint", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("UserAccount with not enough funds", async () => {
        const accs = await getDefaultAccounts();

        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        const {result, error} = await execute(accs, withdrawTooMuch);

        assert(error==="ConstraintRaw", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("UserAccount of other signer", async () => {
        const accs = await getDefaultAccounts();

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));

        accs.userData = await getInitializedUserData(otherSigner, accs.mintData, depositAmount);

        const {result, error, signature} = await execute(accs);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("UserAccount of other mint", async () => {
        const accs = await getDefaultAccounts();

        await getInitializedVault(accs.mintData, depositAmount);

        const otherMint = await getNewMint();
        accs.userData = await getInitializedUserData(accs.signer, otherMint, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("UserAccount of other signer & mint", async () => {
        const accs = await getDefaultAccounts();

        await getInitializedVault(accs.mintData, depositAmount);

        const otherSigner = Keypair.generate();
        await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(otherSigner.publicKey, 1000000000));
        const otherMint = await getNewMint();
        accs.userData = await getInitializedUserData(otherSigner, otherMint, depositAmount);

        const {result, error, signature} = await execute(accs);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("Bad mint vault (uninitialized)", async () => {
        const accs = await getDefaultAccounts();

        const otherMint = await getNewMint();
        accs.vault = SwapVault(otherMint.mint);

        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("Bad mint vault (initialized)", async () => {
        const accs = await getDefaultAccounts();

        const otherMint = await getNewMint();
        accs.vault = SwapVault(otherMint.mint);

        await getInitializedVault(otherMint, depositAmount);
        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        const {result, error} = await execute(accs);

        assert(error==="ConstraintSeeds", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("Wrong vault authority", async () => {
        const accs = await getDefaultAccounts();

        await getInitializedUserData(accs.signer, accs.mintData, depositAmount);

        accs.vaultAuthority = RandomPDA();

        const {result, error} = await execute(accs);

        assert(error==="ConstraintTokenOwner", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.it("Wrong mint", async () => {
        const accs = await getDefaultAccounts();

        const otherMintData = await getNewMint();
        accs.mint = otherMintData.mint;
        
        const {result, error} = await execute(accs);

        assert(error==="AccountNotInitialized", "Invalid transaction error ("+error+"): "+JSON.stringify(result.err));
    });

    parallelTest.execute();

});
