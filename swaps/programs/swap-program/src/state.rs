use anchor_lang::prelude::*;
use crate::SWAP_TYPE_COUNT;
use crate::structs::SwapData;

//Swap contract between offerer and claimer
// HTLC (hash-time locked contract) in case of KIND_LN
// PTLC (proof-time locked contract, where proof is transaction inclusion through bitcoin relay) in case of KIND_CHAIN_*
#[account]
pub struct EscrowState {
    pub data: SwapData,
    
    pub offerer: Pubkey, //Offerer, depositing funds into the swap contract
    pub offerer_ata: Pubkey, //ATA of the offerer, left empty for non pay_in swaps

    pub claimer: Pubkey, //Claimer, able to claim the funds from the swap contract, when spend condition is met
    pub claimer_ata: Pubkey, //ATA of the claimer, ignored for non pay_out swaps

    pub mint: Pubkey, //Pubkey of the token mint

    //Bounty for the watchtower claiming the swap (only for KIND_CHAIN & KIND_CHAIN_NONCED).
    //Alway paid as native Solana, in Lamports
    pub claimer_bounty: u64,

    //Security deposit, paid out to offerer in case swap expires and needs to be refunded.
    //Used to cover transaction fee and compensate for time value of money locked up in the contract.
    //Alway paid as native Solana, in Lamports
    pub security_deposit: u64
}

impl EscrowState {
    pub const SPACE: usize = 8 + 1 + 2 + 8 + 192 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 1;
}

//PDA format for storing user's (LP node's) balance and reputation
#[account]
pub struct UserAccount {
    pub amount: u64, //Amount of tokens held by the user

    /////////////////////////
    // on-chain reputation //
    /////////////////////////
    //Volume of the successfully processed swaps, separate for every KIND_*
    pub success_volume: [u64; SWAP_TYPE_COUNT],
    //Count of the successfully processed swaps, separate for every KIND_*
    pub success_count: [u64; SWAP_TYPE_COUNT],

    //Volume of the failed swaps, separate for every KIND_*
    pub fail_volume: [u64; SWAP_TYPE_COUNT],
    //Count of the failed swaps, separate for every KIND_*
    pub fail_count: [u64; SWAP_TYPE_COUNT],

    //Volume of the cooperatively closed swaps, separate for every KIND_*
    pub coop_close_volume: [u64; SWAP_TYPE_COUNT],
    //Count of the cooperatively closed swaps, separate for every KIND_*
    pub coop_close_count: [u64; SWAP_TYPE_COUNT],
    
    pub bump: u8
}

impl UserAccount {
    pub const SPACE: usize = 8 + 8 + (8*6*SWAP_TYPE_COUNT) + 1;
}
