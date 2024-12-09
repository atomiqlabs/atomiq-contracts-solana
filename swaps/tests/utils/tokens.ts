import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo, getAccount, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, closeAccount, transfer, Account } from "@solana/spl-token";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { assert } from "chai";

const provider = AnchorProvider.local();

export class TokenMint {

    mint: PublicKey;
    mintAuthority: Keypair;

    constructor(mint: PublicKey, mintAuthority: Keypair) {
        this.mint = mint;
        this.mintAuthority = mintAuthority;
    }

    async mintTo(dst: PublicKey, amount: BN): Promise<PublicKey> {
        const dstAta = await getOrCreateAssociatedTokenAccount(provider.connection, this.mintAuthority, this.mint, dst);
        await mintTo(provider.connection, this.mintAuthority, this.mint, dstAta.address, this.mintAuthority, BigInt(amount.toString()));
        return dstAta.address;
    }

    getATA(dst: PublicKey): PublicKey {
        return getAssociatedTokenAddressSync(this.mint, dst);
    }

    async closeAta(signer: Keypair) {
        const dummyAccount = await this.mintTo(Keypair.generate().publicKey, new BN(1));

        const signerAta = getAssociatedTokenAddressSync(this.mint, signer.publicKey);
        const ataAccount = await getAccount(provider.connection, signerAta).catch(e => {});

        if(ataAccount!=null && (ataAccount as Account).amount>BigInt(0)) {
            const signatureTransfer = await transfer(provider.connection, signer, signerAta, dummyAccount, signer, (ataAccount as Account).amount);
            const result = await provider.connection.confirmTransaction(signatureTransfer);
            assert(result.value.err==null, "Transfer ATA transaction error: "+JSON.stringify(result.value.err, null, 4));
        }

        const signature = await closeAccount(provider.connection, signer, signerAta, dummyAccount, signer, undefined, {skipPreflight: true});
        const result = await provider.connection.confirmTransaction(signature);
        assert(result.value.err==null, "Close ATA transaction error: "+JSON.stringify(result.value.err, null, 4));
    }

};

export async function getNewMint(): Promise<TokenMint> {
    const mintAuthority = Keypair.generate();
  
    const signature = await provider.connection.requestAirdrop(mintAuthority.publicKey, 1000000000);
    await provider.connection.confirmTransaction(signature);

    const mint = await createMint(provider.connection, mintAuthority, mintAuthority.publicKey, null, 0);

    return new TokenMint(
        mint,
        mintAuthority
    );
}
