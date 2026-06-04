use anchor_lang::prelude::*;
use crate::SwapType;

#[derive(AnchorSerialize, AnchorDeserialize, Eq, PartialEq, Clone)]
pub struct SwapData {
    pub kind: SwapType, //Kind of the swap, KIND_*
    pub confirmations: u16, //On-chain confirmations required for swap (only on-chain swaps: KIND_CHAIN, KIND_CHAIN_NONCED)
    pub nonce: u64, //Nonce to prevent transaction replays (only KIND_CHAIN_NONCED swaps)
    
    //Locking hash for the swap
    // KIND_LN - payment hash
    // KIND_CHAIN & KIND_CHAIN_NONCED - txo hash
    // KIND_CHAIN_TXHASH - txhash
    pub hash: [u8; 32],

    //Whether the funds were deposited to the contract from external source
    //Used to determine if refund should be paid out to external wallet, or to the contract vault
    pub pay_in: bool,

    //Whether the funds should be paid out to external source
    //Used to determine if payout should be paid out to external wallet, or to the contract vault
    pub pay_out: bool,
    
    pub amount: u64, //Token amount
    pub expiry: u64, //UNIX seconds expiry timestamp, offerer can refund the swap after this timestamp

    //Uniquely identifies this swap PDA
    pub sequence: u64
}
