
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, workspace } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import * as BN from "bn.js";
import { TokenMint } from "../utils/tokens";
import { SwapUserVault, SwapVault, SwapVaultAuthority } from "../utils/accounts";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();

export async function getInitializedVault(mintData: TokenMint, depositAmount: BN): Promise<PublicKey> {
    const signer = Keypair.generate();
    const signerAta = await mintData.mintTo(signer.publicKey, depositAmount);
    const userData = SwapUserVault(signer.publicKey, mintData.mint);
    const vault = SwapVault(mintData.mint);
    const vaultAuthority = SwapVaultAuthority;
    const mint = mintData.mint;
    const systemProgram = SystemProgram.programId;
    const tokenProgram = TOKEN_PROGRAM_ID;
    
    await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(signer.publicKey, 1000000000));
    
    const tx = await program.methods.deposit(depositAmount).accounts({
        signer: signer.publicKey,
        signerAta,
        userData,
        vault,
        vaultAuthority,
        mint,
        systemProgram,
        tokenProgram
    }).transaction();

    tx.feePayer = signer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [signer], {
        skipPreflight: true
    });
    const result = await provider.connection.confirmTransaction(signature);

    assert(result.value.err==null, "getInitializedVault(): Transaction error: "+JSON.stringify(result.value.err, null, 4));

    return vault;
}